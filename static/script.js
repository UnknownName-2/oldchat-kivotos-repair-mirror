function escapeHtml(text) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', () => {
    const myUid = document.querySelector('meta[name="uid"]')?.content || '';

    let currentConv = null;
    const seenMsgIds = {};  // 按会话存储已见消息 ID
    let switchRequestId = 0;  // 请求序号，防止竞态
    let contacts = { friends: [], groups: [] };

    const contactList = document.getElementById('contactList');
    const chatHeader = document.getElementById('chatHeader');
    const messagesContainer = document.getElementById('messagesContainer');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const moreBtn = document.getElementById('moreBtn');
    const moreMenu = document.getElementById('moreMenu');
    const fileInput = document.getElementById('fileInput');
    const themeToggle = document.getElementById('themeToggle');
    const logoutBtn = document.getElementById('logoutBtn');
    const pinSidebarBtn = document.getElementById('pinSidebarBtn');
    const aboutBtn = document.getElementById('aboutBtn');

    const quotePreview = document.getElementById('quotePreview');
    const quotePreviewText = quotePreview.querySelector('.quote-preview-text');
    const cancelQuoteBtn = document.getElementById('cancelQuoteBtn');
    let pendingQuote = null;

    let contextMenu = null;
    let contextMsgId = null;

    function hideContextMenu() {
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
            contextMsgId = null;
        }
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    themeToggle.addEventListener('click', () => {
        const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        setTheme(newTheme);
    });

    logoutBtn.addEventListener('click', () => {
        window.location.href = '/logout';
    });

    aboutBtn.addEventListener('click', () => {
        window.location.href = '/static/about.html';
    });

    async function loadContacts() {
        try {
            const res = await fetch('/api/contacts');
            const data = await res.json();
            if (data.error) { alert(data.error); return; }
            contacts = data;
            renderContacts();
        } catch (e) { console.error(e); }
    }

    function renderContacts() {
        contactList.innerHTML = '';
        contacts.friends.forEach(f => {
            const div = createContactItem(f.uid, f.name, 'direct');
            contactList.appendChild(div);
        });
        contacts.groups.forEach(g => {
            const div = createContactItem(g.id, g.name, 'group');
            contactList.appendChild(div);
        });
    }

    function createContactItem(id, name, type) {
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="uid">${escapeHtml(id)}</div>`;
        div.addEventListener('click', (e) => switchConversation(type, id, name, e));
        return div;
    }

    async function switchConversation(type, id, name, event) {
        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        }
    
        const convKey = `${type}:${id}`;
        currentConv = { type, id, name, key: convKey };
    
        // 保存到 localStorage，下次自动恢复
        try {
            localStorage.setItem('lastConversation', convKey);
        } catch (e) {}
    
        chatHeader.innerHTML = `<span>${escapeHtml(name)}</span>`;
        messagesContainer.innerHTML = '';
    
        // 清除该会话的已见消息记录，确保历史消息重新显示
        if (seenMsgIds[convKey]) {
            delete seenMsgIds[convKey];
        }
    
        pendingQuote = null;
        quotePreview.style.display = 'none';
    
        const reqId = ++switchRequestId;
    
        try {
            const res = await fetch(`/api/messages/${type}/${id}`);
            const data = await res.json();
    
            if (reqId !== switchRequestId) return;
    
            if (data.error) {
                console.error(data.error);
                messagesContainer.innerHTML = '<div class="system-msg">加载消息失败，请刷新重试</div>';
                return;
            }
    
            // 重新创建该会话的已见集合
            if (!seenMsgIds[convKey]) {
                seenMsgIds[convKey] = new Set();
            }
            const currentSeen = seenMsgIds[convKey];
    
            data.messages.forEach(msg => {
                appendMessage(msg, convKey, currentSeen);
            });
            scrollToBottom();
            await fetch(`/api/mark_read/${type}/${id}`, { method: 'PUT' });
        } catch (e) {
            console.error(e);
            if (reqId === switchRequestId) {
                messagesContainer.innerHTML = '<div class="system-msg">网络错误，无法加载消息</div>';
            }
        }
    }

    function appendMessage(msg, convKey, currentSeen) {
        if (!msg || !msg.id) return;
        if (!convKey) convKey = currentConv?.key;
        if (!convKey) return;
    
        if (!currentSeen) {
            if (!seenMsgIds[convKey]) seenMsgIds[convKey] = new Set();
            currentSeen = seenMsgIds[convKey];
        }
    
        if (currentSeen.has(msg.id)) return;
        currentSeen.add(msg.id);
    
        const fromUid = msg.from_uid || '';
        const isSelf = fromUid.toUpperCase() === myUid.toUpperCase();
        const sender = isSelf ? '你' : (msg.from_name || fromUid);
        const time = new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false });
        const msgType = msg.msg_type || 'text';
        let content = '';
    
        if (msgType === 'text') {
            let body = msg.body || '';
            let quoteHtml = '';
    
            if (body.trim().startsWith('{')) {
                try {
                    const obj = JSON.parse(body);
                    if (obj.v === 2) {
                        let textBody = obj.text || '';
                        if (obj.quote) {
                            const quote = obj.quote;
                            quoteHtml = `
                                <div class="quote-block" data-quoted-id="${escapeHtml(quote.id || '')}">
                                    <div class="quote-sender">${escapeHtml(quote.from_name || quote.from_uid || '')}</div>
                                    <div>${escapeHtml(quote.text || '')}</div>
                                </div>`;
                        }
                        if (obj.mentions && Array.isArray(obj.mentions)) {
                            obj.mentions.forEach(m => {
                                const name = m.name || m.uid;
                                const regex = new RegExp(`@${escapeRegExp(name)}`, 'g');
                                textBody = textBody.replace(regex, 
                                    `<span class="mention-highlight" data-uid="${escapeHtml(m.uid || '')}">@${escapeHtml(name)}</span>`);
                            });
                        }
                        content = quoteHtml + (textBody ? `<div>${textBody}</div>` : '');
                    } else {
                        body = escapeHtml(body);
                        content = `<div>${body}</div>`;
                    }
                } catch (e) {
                    body = escapeHtml(body);
                    content = `<div>${body}</div>`;
                }
            } else {
                body = escapeHtml(body);
                content = `<div>${body}</div>`;
            }
        } else if (msgType === 'image') {
            content = `<img src="${msg.media_url}" style="max-width:200px; max-height:200px; cursor:pointer;" onclick="window.open(this.src)">`;
        } else if (msgType === 'video') {
            content = `<video controls style="max-width:200px;"><source src="${msg.media_url}"></video>`;
        } else if (msgType === 'red_packet') {
            let packetData = null;
            try {
                if (msg.body && msg.body.trim().startsWith('{')) {
                    packetData = JSON.parse(msg.body);
                }
            } catch (e) {}
            if (packetData && packetData.packet_id) {
                const packetId = packetData.packet_id;
                const totalAmount = packetData.total_amount || '?';
                const totalCount = packetData.total_count || '?';
                content = `
                    <div class="red-packet-card" data-packet-id="${escapeHtml(packetId)}" data-claimed="false">
                        <div class="rp-icon">🧧</div>
                        <div class="rp-info">
                            <div class="rp-title">红包</div>
                            <div class="rp-desc">总额 ${totalAmount} · ${totalCount}个</div>
                        </div>
                        <div class="rp-status">点击领取</div>
                    </div>`;
            } else {
                content = `[红包] ${escapeHtml(msg.body || '')}`;
            }
        } else if (msgType === 'voice') {
            if (msg.media_url) {
                const dur = (msg.duration_ms || 0) / 1000;
                content = `
                    <div class="voice-message">
                        <audio controls preload="metadata" src="${msg.media_url}">
                            Sensei，对不起，您的浏览器不支持音频播放
                        </audio>
                        <span class="voice-duration">${dur ? dur.toFixed(1) + '秒' : ''}</span>
                    </div>`;
            } else {
                const dur = (msg.duration_ms || 0) / 1000;
                content = `[语音 ${dur}秒]`;
            }
        } else if (msgType === 'resource') {
            let fileName = msg.body || '';
            if (!fileName && msg.media_url) {
                const urlParts = msg.media_url.split('/');
                fileName = decodeURIComponent(urlParts.pop()) || '文件';
            }
            content = `
                <div class="file-card">
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(fileName)}</div>
                    </div>
                    <a href="${msg.media_url}" target="_blank" class="file-download-btn">⬇</a>
                </div>`;
        } else {
            content = `[${msgType}] ${escapeHtml(msg.body || '')}`;
        }
    
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${isSelf ? 'self' : 'other'}`;
        msgDiv.dataset.msgId = msg.id;
        msgDiv.dataset.fromUid = msg.from_uid || '';
        msgDiv.dataset.fromName = msg.from_name || msg.from_uid || '';
        msgDiv.dataset.msgType = msg.msg_type || 'text';
        
        if (!isSelf) {
            // 添加头像
            const avatarUrl = msg.from_avatar || '/static/default-avatar.png'; // 默认头像
            const avatarImg = document.createElement('img');
            avatarImg.src = avatarUrl;
            avatarImg.className = 'msg-avatar';
            avatarImg.onerror = () => { avatarImg.src = '/static/default-avatar.png'; };
            avatarImg.addEventListener('click', (e) => {
                e.stopPropagation();
                const uid = msg.from_uid;
                if (uid) {
                    window.location.href = `/space/${uid}`;
                }
            });
            msgDiv.appendChild(avatarImg);
        }
        
        // 气泡包裹层
        const bubbleWrapper = document.createElement('div');
        bubbleWrapper.className = 'message-content';
        bubbleWrapper.innerHTML = `
            ${msg.group_id && !isSelf ? `<div class="message-sender">${escapeHtml(sender)}</div>` : ''}
            <div class="message-bubble">${content}</div>
            <div class="message-time">${time}</div>
        `;
        msgDiv.appendChild(bubbleWrapper);
        
        const bubble = msgDiv.querySelector('.message-bubble');
        if (bubble) {
            msgDiv.dataset.plainText = bubble.innerText;
        }
        messagesContainer.appendChild(msgDiv);
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    async function sendMessage(body, msgType = 'text', mediaUrl = null, thumbUrl = null) {
        if (!currentConv) return;
        
        if (pendingQuote && msgType === 'text' && body.trim()) {
            const quotePayload = {
                v: 2,
                text: body,
                quote: pendingQuote
            };
            body = JSON.stringify(quotePayload);
            msgType = 'text';
        }

        const payload = {
            type: currentConv.type,
            to_id: currentConv.id,
            body: body,
            msg_type: msgType,
            burn_after_seconds: 0,
            media_url: mediaUrl || null,
            thumb_url: thumbUrl || null
        };
        try {
            const res = await fetch('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.error) {
                alert('发送失败: ' + data.error);
                return;
            }
            if (pendingQuote) {
                pendingQuote = null;
                quotePreview.style.display = 'none';
            }
            if (data.message) {
                appendMessage(data.message, currentConv.key, seenMsgIds[currentConv.key]);
                scrollToBottom();
            }
        } catch (e) { console.error(e); }
    }

    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = this.value.trim();
            if (text) {
                sendMessage(text);
                this.value = '';
            }
        }
    });

    sendBtn.addEventListener('click', () => {
        const text = messageInput.value.trim();
        if (text) {
            sendMessage(text);
            messageInput.value = '';
        }
    });

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moreMenu.style.display = moreMenu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', () => {
        moreMenu.style.display = 'none';
    });

    document.getElementById('sendImageBtn').addEventListener('click', () => {
        fileInput.accept = 'image/*';
        fileInput.click();
    });
    document.getElementById('sendFileBtn').addEventListener('click', () => {
        fileInput.accept = '*';
        fileInput.click();
    });

    const sendEmoticonBtn = document.getElementById('sendEmoticonBtn');
    sendEmoticonBtn.addEventListener('click', () => {
        showEmoticonPicker();
    });

    fileInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        const file = files[0];
        if (!confirm(`是否发送文件 "${file.name}"？`)) return;
        await uploadAndSend(file);
        fileInput.value = '';
    });

    const chatArea = document.querySelector('.chat-area');
    chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    chatArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (!files.length || !currentConv) return;
        const file = files[0];
        if (!confirm(`是否发送文件 "${file.name}" 到当前会话？`)) return;
        await uploadAndSend(file);
    });

    async function uploadAndSend(file) {
        if (!currentConv) return;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('conv_type', currentConv.type);
        formData.append('to_id', currentConv.id);
        try {
            const res = await fetch('/api/upload_and_send', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.error) {
                alert('发送失败: ' + data.error);
                return;
            }
            if (data.message) {
                appendMessage(data.message, currentConv.key, seenMsgIds[currentConv.key]);
                scrollToBottom();
            }
        } catch (error) {
            console.error(error);
            alert('网络错误，发送失败');
        }
    }

    document.addEventListener('contextmenu', (e) => {
        hideContextMenu();
        
        // 排除输入框区域（textarea 和其父级）
        if (e.target.closest('.input-area') || e.target.closest('textarea') || e.target.closest('#messageInput')) {
            return;  // 让系统默认菜单弹出
        }
        
        // 优先显示消息菜单
        const msgDiv = e.target.closest('.message');
        if (msgDiv) {
            e.preventDefault();
            const msgId = msgDiv.dataset.msgId;
            if (!msgId) return;
    
            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.innerHTML = `
                <div class="context-menu-item" data-action="copy">复制</div>
                <div class="context-menu-divider"></div>
                <div class="context-menu-item" data-action="quote">引用</div>
            `;
            document.body.appendChild(menu);
            contextMenu = menu;
            contextMsgId = msgId;
    
            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'copy') {
                    const bubble = msgDiv.querySelector('.message-bubble');
                    if (bubble) {
                        const text = bubble.innerText;
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(text).catch(() => fallbackCopy(bubble));
                        } else {
                            fallbackCopy(bubble);
                        }
                    }
                } else if (action === 'quote') {
                    const fromUid = msgDiv.dataset.fromUid;
                    const fromName = msgDiv.dataset.fromName;
                    const msgType = msgDiv.dataset.msgType;
                    const plainText = msgDiv.dataset.plainText || '';
    
                    pendingQuote = {
                        id: msgId,
                        from_uid: fromUid,
                        from_name: fromName,
                        type: msgType,
                        text: plainText.substring(0, 200)
                    };
    
                    quotePreviewText.textContent = `引用: ${fromName} - ${plainText.substring(0, 50)}`;
                    quotePreview.style.display = 'flex';
                    messageInput.focus();
                }
                hideContextMenu();
            });
    
            const closeHandler = (ev) => {
                if (!menu.contains(ev.target)) {
                    hideContextMenu();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
            return;
        }
    
        // 其次判断是否在右侧聊天区域（.chat-area 或 .messages）的空白处
        // 注意：此时已经排除了 input-area
        const chatArea = e.target.closest('.chat-area');
        if (chatArea) {
            e.preventDefault();
            const menu = document.createElement('div');
            menu.className = 'custom-context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.innerHTML = `
                <div class="context-menu-item" data-action="refresh">刷新</div>
            `;
            document.body.appendChild(menu);
            contextMenu = menu;
    
            menu.addEventListener('click', (event) => {
                const action = event.target.dataset.action;
                if (action === 'refresh') {
                    location.reload();
                }
                hideContextMenu();
            });
    
            const closeHandler = (ev) => {
                if (!menu.contains(ev.target)) {
                    hideContextMenu();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
            return;
        }
    });



    function fallbackCopy(element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        try { document.execCommand('copy'); } catch (e) { alert('复制失败'); }
        selection.removeAllRanges();
    }

    cancelQuoteBtn.addEventListener('click', () => {
        pendingQuote = null;
        quotePreview.style.display = 'none';
        messageInput.focus();
    });

    // 轮询未读
    setInterval(async () => {
        if (!currentConv) return;
        const convKey = currentConv.key;
        try {
            const res = await fetch('/api/unread');
            const data = await res.json();
            if (data.error) return;
            const allUnread = [...(data.direct || []), ...(data.groups || [])];
            for (const msg of allUnread) {
                const convKeyMsg = msg.group_id ? `group:${msg.group_id}` : `direct:${msg.from_uid}`;
                // 只处理当前会话的消息
                if (convKeyMsg !== convKey) continue;
                appendMessage(msg, convKey, seenMsgIds[convKey]);
                scrollToBottom();
                await fetch(`/api/mark_read/${msg.group_id ? 'group' : 'direct'}/${msg.group_id || msg.from_uid}`, { method: 'PUT' });
            }
        } catch (e) {}
    }, 2000);


    // ===== 侧边栏固定/自动隐藏（绝对定位平移） =====
    let sidebarPinned = true;
    const sidebar = document.querySelector('.sidebar');


    function expandChat() {
        chatArea.style.marginLeft = sidebar.classList.contains('collapsed') ? '0px' : '280px';
    }

    pinSidebarBtn.addEventListener('click', () => {
        sidebarPinned = !sidebarPinned;
        if (sidebarPinned) {
            sidebar.classList.remove('collapsed');
            pinSidebarBtn.innerHTML = '▣';
            pinSidebarBtn.title = '取消固定';
            expandChat();
            // 动画完成后强制调整宽度
            setTimeout(expandChat, 350);
        } else {
            sidebar.classList.add('collapsed');
            pinSidebarBtn.innerHTML = '◰';
            pinSidebarBtn.title = '固定侧边栏';
            expandChat();
        }
    });

    // 鼠标移到屏幕最左侧边缘时，如果未固定且隐藏，则展开
    document.addEventListener('mousemove', (e) => {
        if (!sidebarPinned && sidebar.classList.contains('collapsed') && e.clientX < 5) {
            sidebar.classList.remove('collapsed');
            expandChat();
            setTimeout(expandChat, 350);
        }
    });

    // 鼠标离开侧边栏时，如果未固定，自动隐藏（带短延迟）
    let leaveTimer;
    sidebar.addEventListener('mouseleave', () => {
        if (!sidebarPinned && !sidebar.classList.contains('collapsed')) {
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(() => {
                sidebar.classList.add('collapsed');
                expandChat(); // 隐藏时 margin-left 为 0
            }, 200);
        }
    });
    sidebar.addEventListener('mouseenter', () => {
        clearTimeout(leaveTimer);
    });

    // 直链图片发送
    const sendUrlImageBtn = document.getElementById('sendUrlImageBtn');
    const urlInputOverlay = document.getElementById('urlInputOverlay');
    const urlImageInput = document.getElementById('urlImageInput');
    const urlInputCancel = document.getElementById('urlInputCancel');
    const urlInputSend = document.getElementById('urlInputSend');

    sendUrlImageBtn.addEventListener('click', () => {
        urlInputOverlay.style.display = 'flex';
        urlImageInput.value = '';
        urlImageInput.focus();
    });

    urlInputCancel.addEventListener('click', () => {
        urlInputOverlay.style.display = 'none';
    });
    urlInputOverlay.addEventListener('click', (e) => {
        if (e.target === urlInputOverlay) urlInputOverlay.style.display = 'none';
    });

    urlInputSend.addEventListener('click', () => {
        const url = urlImageInput.value.trim();
        if (!url) { alert('请输入图片链接'); return; }
        // 简单校验是否为http开头
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            alert('请输入完整的网络地址（http:// 或 https:// 开头）');
            return;
        }
        sendMessage('', 'image', url);
        urlInputOverlay.style.display = 'none';
    });
    
    // 红包领取处理（事件委托）
    document.addEventListener('click', async (e) => {
        const card = e.target.closest('.red-packet-card');
        if (!card) return;
        const claimed = card.dataset.claimed === 'true';
        if (claimed) return; // 已领取不再请求

        const packetId = card.dataset.packetId;
        if (!packetId) return;

        // 立即禁用，避免重复点击
        card.dataset.claimed = 'true';
        card.style.pointerEvents = 'none';
        card.querySelector('.rp-status').textContent = '领取中...';

        try {
            const res = await fetch('/api/redpacket/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packet_id: packetId })
            });
            const data = await res.json();
            if (data.error) {
                card.querySelector('.rp-status').textContent = data.error;
                card.style.opacity = '0.7';
            } else {
                // 领取成功，显示金额（如果接口返回 amount 字段）
                const amount = data.amount !== undefined ? data.amount : '';
                card.querySelector('.rp-status').textContent = amount ? `已领取 ${amount}` : '已领取';
                card.style.opacity = '0.7';
                card.style.cursor = 'default';
            }
        } catch (err) {
            card.querySelector('.rp-status').textContent = '网络错误';
            card.style.opacity = '0.7';
        }
    });

    async function showEmoticonPicker() {
        const existing = document.getElementById('emoticonPicker');
        if (existing) existing.remove();
    
        try {
            const res = await fetch('/api/emoticons');
            const data = await res.json();
            const images = data.images || [];
            if (images.length === 0) {
                alert('没有可用的表情包');
                return;
            }
    
            const picker = document.createElement('div');
            picker.id = 'emoticonPicker';
            picker.className = 'emoticon-picker';
            picker.innerHTML = `<div class="emoticon-grid"></div>`;
            const grid = picker.querySelector('.emoticon-grid');
    
            images.forEach(img => {
                const imgUrl = `/static/images/${img}`;
                const item = document.createElement('div');
                item.className = 'emoticon-item';
                item.innerHTML = `<img src="${imgUrl}" loading="lazy">`;
                item.addEventListener('click', async () => {
                    picker.remove();
                    try {
                        const response = await fetch(imgUrl);
                        const blob = await response.blob();
                        const formData = new FormData();
                        formData.append('file', blob, img);
                        const uploadRes = await fetch('/api/upload_only', {
                            method: 'POST',
                            body: formData
                        });
                        const uploadData = await uploadRes.json();
                        if (uploadData.error) {
                            alert('上传表情失败: ' + uploadData.error);
                            return;
                        }
                        sendMessage('', 'image', uploadData.media_url, uploadData.thumb_url);
                    } catch (err) {
                        console.error(err);
                        alert('发送表情失败');
                    }
                });
                grid.appendChild(item);
            });
    
            document.body.appendChild(picker);
    
            const closeHandler = (e) => {
                if (!picker.contains(e.target)) {
                    picker.remove();
                    document.removeEventListener('click', closeHandler);
                }
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        } catch (e) {
            console.error(e);
            alert('加载表情失败');
        }
    }


    expandChat();
    loadContacts().then(() => {
        // 读取上次打开的会话
        const lastConv = localStorage.getItem('lastConversation');
        if (lastConv) {
            const [type, id] = lastConv.split(':');
            if (type && id) {
                let found = null;
                if (type === 'direct') {
                    found = contacts.friends.find(f => f.uid === id);
                } else if (type === 'group') {
                    found = contacts.groups.find(g => g.id === id);
                }
                if (found) {
                    const name = found.name || (type === 'direct' ? found.uid : found.id);
                    switchConversation(type, id, name);
                }
            }
        }
    });
});