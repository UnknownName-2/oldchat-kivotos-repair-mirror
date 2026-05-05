from flask import Blueprint, request, session, redirect, url_for, render_template
from oldchat_api import OldChatAPI

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/login', methods=['GET', 'POST'])
def login_page():
    if request.method == 'POST':
        identifier = request.form['identifier']
        password = request.form['password']
        try:
            api = OldChatAPI()
            user = api.login(identifier, password)
            session['access_token'] = api.access_token
            session['refresh_token'] = api.refresh_token
            session['user_name'] = user.get('display_name', user.get('username'))
            session['uid'] = user.get('uid')
            return redirect(url_for('index'))
        except Exception as e:
            return render_template('login.html', error=str(e))
    return render_template('login.html')

@auth_bp.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('auth.login_page'))