import os
import tempfile
from flask import Blueprint, request, session, jsonify, g, current_app
from oldchat_api import OldChatAPI

api_bp = Blueprint('api', __name__)

def require_api():
    if not g.api:
        return jsonify({'error': '未登录'}), 401
    return None

def fix_message_urls(msg):
    """将相对路径的媒体URL补全为绝对URL"""
    if not g.api:
        return msg
    base = g.api.base_url.rstrip('/')
    if msg.get('media_url', '').startswith('/'):
        msg['media_url'] = base + msg['media_url']
    if msg.get('thumb_url', '').startswith('/'):
        msg['thumb_url'] = base + msg['thumb_url']
    return msg

def enrich_message_names(msgs, conv_type, conv_id=None):
    """为消息补充 from_name（昵称），如果缺失则从服务器获取"""
    if not g.api or not msgs:
        return
    uid_map = {}
    try:
        if conv_type == 'direct':
            # 私聊：使用好友列表映射
            friends = g.api.get_friends()
            for f in friends:
                uid_map[f.get('uid', '').upper()] = f.get('display_name') or f.get('username') or f.get('uid')
        elif conv_type == 'group' and conv_id:
            # 群聊：获取群成员映射
            members = g.api.get_group_members(conv_id)
            uid_map = {uid.upper(): name for uid, name in members.items()}
    except Exception as e:
        print(f"[enrich] 获取名称映射失败: {e}")
        return

    for msg in msgs:
        from_uid = msg.get('from_uid', '')
        if not from_uid or msg.get('from_name'):
            continue
        name = uid_map.get(from_uid.upper(), '')
        if name:
            msg['from_name'] = name

def guess_msg_type(filename: str) -> str:
    """根据文件扩展名判断消息类型"""
    ext = os.path.splitext(filename)[1].lower()
    if ext in ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'):
        return 'image'
    elif ext in ('.mp4', '.mov', '.avi', '.mkv'):
        return 'video'
    elif ext in ('.mp3', '.wav', '.ogg', '.aac'):
        return 'voice'
    else:
        return 'resource'

@api_bp.route('/contacts')
def contacts():
    if not g.api:
        return require_api()
    try:
        friends = []
        for f in g.api.get_friends():
            friends.append({
                'uid': f.get('uid', '').upper(),
                'name': f.get('display_name') or f.get('username') or f.get('uid')
            })
        groups = []
        for grp in g.api.get_groups():
            groups.append({
                'id': grp.get('group_id', '').upper(),
                'name': grp.get('name', grp.get('group_id'))
            })
        return jsonify({'friends': friends, 'groups': groups})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/messages/<conv_type>/<conv_id>')
def get_messages(conv_type, conv_id):
    if not g.api:
        return require_api()
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    try:
        if conv_type == 'direct':
            msgs = g.api.get_direct_messages(conv_id, limit, offset)
        elif conv_type == 'group':
            msgs = g.api.get_group_messages(conv_id, limit, offset)
        else:
            return jsonify({'error': 'Invalid conversation type'}), 400
        msgs.sort(key=lambda x: x.get('created_at', 0))
        for msg in msgs:
            fix_message_urls(msg)
        enrich_message_names(msgs, conv_type, conv_id)   # ← 新增这一行
        return jsonify({'messages': msgs})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/unread')
def unread():
    if not g.api:
        return require_api()
    try:
        direct = g.api.get_unread_direct(limit=50)
        groups = g.api.get_unread_groups(limit=50)

        # 补充名称
        if direct:
            enrich_message_names(direct, 'direct')          # 私聊用好友列表
        for gmsg in groups:
            group_id = gmsg.get('group_id', '')
            if group_id:
                enrich_message_names([gmsg], 'group', group_id)  # 群聊逐条补

        for msg in direct:
            fix_message_urls(msg)
        for msg in groups:
            fix_message_urls(msg)
        return jsonify({'direct': direct, 'groups': groups})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/mark_read/<conv_type>/<conv_id>', methods=['PUT'])
def mark_read(conv_type, conv_id):
    if not g.api:
        return require_api()
    try:
        if conv_type == 'direct':
            g.api.mark_direct_read(conv_id)
        elif conv_type == 'group':
            g.api.mark_group_read(conv_id)
        else:
            return jsonify({'error': 'Invalid type'}), 400
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/send', methods=['POST'])
def send_message():
    if not g.api:
        return require_api()
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No JSON data'}), 400
    conv_type = data.get('type')
    to_id = data.get('to_id')
    body = data.get('body', '')
    msg_type = data.get('msg_type', 'text')
    burn = data.get('burn_after_seconds', 0)
    media_url = data.get('media_url')
    thumb_url = data.get('thumb_url')

    try:
        if conv_type == 'direct':
            g.api.send_direct_message(to_id, body, msg_type, burn, media_url, thumb_url)
            latest_msgs = g.api.get_direct_messages(to_id, limit=1, offset=0)
        elif conv_type == 'group':
            g.api.send_group_message(to_id, body, msg_type, burn, media_url, thumb_url)
            latest_msgs = g.api.get_group_messages(to_id, limit=1, offset=0)
        else:
            return jsonify({'error': 'Invalid type'}), 400

        if latest_msgs:
            latest_msg = latest_msgs[0]
            fix_message_urls(latest_msg)
            enrich_message_names([latest_msg], conv_type, to_id)   # ← 新增
            return jsonify({'status': 'ok', 'message': latest_msg})
        else:
            return jsonify({'status': 'ok', 'message': None})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== 上传并发送 ==========
@api_bp.route('/upload_and_send', methods=['POST'])
def upload_and_send():
    if not g.api:
        return require_api()
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    conv_type = request.form.get('conv_type')
    to_id = request.form.get('to_id')
    if not conv_type or not to_id:
        return jsonify({'error': 'Missing conv_type or to_id'}), 400

    fd, tmp_path = tempfile.mkstemp(suffix=os.path.splitext(file.filename)[1])
    try:
        file.save(tmp_path)
        # 刷新 token，防止过期
        try:
            g.api._refresh()
        except Exception as e:
            print(f"[upload_and_send] token refresh failed: {e}")

        msg_type = guess_msg_type(file.filename)
        is_group = (conv_type == 'group')

        # 调用 OldChatAPI 的便捷方法
        success = False
        if msg_type == 'image':
            success = g.api.send_image(to_id, is_group, tmp_path)
        elif msg_type == 'video':
            success = g.api.send_video(to_id, is_group, tmp_path)
        elif msg_type == 'voice':
            success = g.api.send_voice(to_id, is_group, tmp_path)
        else:
            success = g.api.send_file(to_id, is_group, tmp_path)

        if not success:
            return jsonify({'error': '文件发送失败（上传或发送出错）'}), 500

        # 拉取最后一条消息
        if conv_type == 'direct':
            latest_msgs = g.api.get_direct_messages(to_id, limit=1, offset=0)
        else:
            latest_msgs = g.api.get_group_messages(to_id, limit=1, offset=0)

        if latest_msgs:
            latest_msg = latest_msgs[0]
            fix_message_urls(latest_msg)
            enrich_message_names([latest_msg], conv_type, to_id)   # ← 新增：补充昵称
            return jsonify({'status': 'ok', 'message': latest_msg})
        else:
            return jsonify({'status': 'ok', 'message': None})

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        os.close(fd)
        os.unlink(tmp_path)

@api_bp.route('/redpacket/claim', methods=['POST'])
def claim_redpacket():
    if not g.api:
        return require_api()
    data = request.get_json()
    if not data or 'packet_id' not in data:
        return jsonify({'error': 'Missing packet_id'}), 400
    try:
        result = g.api.claim_redpacket(data['packet_id'])
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/emoticons')
def get_emoticons():
    if not g.api:
        return require_api()
    img_dir = os.path.join(current_app.root_path, 'static', 'images')
    if not os.path.exists(img_dir):
        return jsonify({'images': []})
    files = os.listdir(img_dir)
    allowed_ext = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp')
    images = [f for f in files if os.path.splitext(f)[1].lower() in allowed_ext]
    return jsonify({'images': sorted(images)})

@api_bp.route('/upload_only', methods=['POST'])
def upload_only():
    """只上传文件到 OldChat 服务器，返回 media_url 和 thumb_url"""
    if not g.api:
        return require_api()
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    fd, tmp_path = tempfile.mkstemp(suffix=os.path.splitext(file.filename)[1])
    try:
        file.save(tmp_path)
        # 刷新 token
        try:
            g.api._refresh()
        except Exception:
            pass

        # 直接调用 upload_media 方法（它已经支持 webp 等多种格式）
        media_url, thumb_url = g.api.upload_media(tmp_path)
        if not media_url:
            return jsonify({'error': '上传失败，服务器拒绝该文件'}), 400

        # upload_media 内部已经补全绝对路径，但为安全再检查一次
        if media_url.startswith('/'):
            media_url = g.api.base_url + media_url
        if thumb_url and thumb_url.startswith('/'):
            thumb_url = g.api.base_url + thumb_url

        return jsonify({'media_url': media_url, 'thumb_url': thumb_url})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        os.close(fd)
        os.unlink(tmp_path)