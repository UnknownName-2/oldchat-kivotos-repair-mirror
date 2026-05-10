import os
import secrets
from datetime import datetime
from flask import Flask, session, g, redirect, url_for, render_template
from auth import auth_bp
from api import api_bp
from oldchat_api import OldChatAPI
from waitress import serve

def create_app():
    app = Flask(__name__)
    app.secret_key = secrets.token_hex(32)

    # 自定义模板过滤器：将时间戳转为可读时间
    @app.template_filter('datetimeformat')
    def datetimeformat(timestamp):
        if not timestamp:
            return ''
        return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M')

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp, url_prefix='/api')

    @app.before_request
    def before_request():
        g.api = None
        if 'access_token' in session and 'refresh_token' in session:
            api = OldChatAPI()
            api.access_token = session['access_token']
            api.refresh_token = session['refresh_token']
            g.api = api

    @app.after_request
    def after_request(response):
        if g.api and (g.api.access_token != session.get('access_token') or
                      g.api.refresh_token != session.get('refresh_token')):
            session['access_token'] = g.api.access_token
            session['refresh_token'] = g.api.refresh_token
        return response

    @app.route('/')
    def index():
        if 'access_token' not in session:
            return redirect(url_for('auth.login_page'))
        return render_template('index.html')

    @app.route('/space/<uid>')
    def user_space(uid):
        if 'access_token' not in session:
            return redirect(url_for('auth.login_page'))

        api = OldChatAPI()
        api.access_token = session['access_token']
        api.refresh_token = session['refresh_token']
        try:
            profile = api.get_user_profile(uid)
            base = api.base_url
            for field in ['avatar_url', 'cover_url']:
                url = profile.get(field, '')
                if url and url.startswith('/'):
                    profile[field] = base + url

            moments = []
            try:
                moments = api.get_user_moments(uid, limit=10)
            except Exception as e:
                print(f"获取动态失败: {e}")

            return render_template('space.html', user=profile, moments=moments)
        except Exception as e:
            return f"<h2>获取用户信息失败</h2><p>{e}</p>", 500

    return app   # 必须放在最后

if __name__ == '__main__':
    import logging
    app = create_app()
    logger = logging.getLogger('waitress')
    logger.setLevel(logging.INFO)
    serve(app, host='0.0.0.0', port=5000, threads=8)