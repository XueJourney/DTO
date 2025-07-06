// 处理登录表单提交
document.addEventListener('DOMContentLoaded', function() {
  const loginForm = document.getElementById('login-form');
  
  if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errorMessage = document.getElementById('error-message');
      
      // 发送登录请求
      fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          // 登录成功，重定向到日志页面
          window.location.href = '/logs';
        } else {
          // 显示错误消息
          errorMessage.textContent = data.message || '用户名或密码错误';
        }
      })
      .catch(error => {
        console.error('登录出错:', error);
        errorMessage.textContent = '登录过程中出现错误，请重试';
      });
    });
  }
  
  // 检查登录状态并显示用户名
  function checkAuthStatus() {
    fetch('/api/auth/status')
      .then(response => response.json())
      .then(data => {
        if (!data.authenticated && window.location.pathname !== '/login') {
          // 如果未登录且不在登录页面，重定向到登录页
          window.location.href = '/login';
        } else if (data.authenticated && window.location.pathname === '/login') {
          // 如果已登录但在登录页，重定向到日志页
          window.location.href = '/logs';
        }
        
        // 如果已登录，显示用户名
        if (data.authenticated && data.username) {
          const usernameDisplay = document.getElementById('username-display');
          if (usernameDisplay) {
            usernameDisplay.textContent = `欢迎, ${data.username}`;
          }
        }
      })
      .catch(error => {
        console.error('验证状态检查失败:', error);
      });
  }
  
  // 处理登出
  const logoutButton = document.getElementById('logout-btn');
  if (logoutButton) {
    logoutButton.addEventListener('click', function() {
      fetch('/api/auth/logout', {
        method: 'POST'
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          window.location.href = '/login';
        }
      })
      .catch(error => {
        console.error('登出失败:', error);
      });
    });
  }
  
  // 检查登录状态
  checkAuthStatus();
}); 