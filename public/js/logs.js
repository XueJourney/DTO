document.addEventListener('DOMContentLoaded', function() {
  let currentPage = 1;
  let totalPages = 1;
  const itemsPerPage = 20;
  
  const logsTable = document.getElementById('logs-table');
  const paginationContainer = document.getElementById('pagination');
  const searchInput = document.getElementById('search-input');
  const statusFilter = document.getElementById('status-filter');
  const ipFilter = document.getElementById('ip-filter');
  const logModal = document.getElementById('log-modal');
  const modalContent = document.querySelector('.modal-content');
  const closeModalBtn = document.querySelector('.close-modal');
  
  // 初始加载日志
  loadLogs();
  
  // 搜索和筛选
  if (searchInput) {
    searchInput.addEventListener('input', debounce(function() {
      currentPage = 1;
      loadLogs();
    }, 500));
  }
  
  if (statusFilter) {
    statusFilter.addEventListener('change', function() {
      currentPage = 1;
      loadLogs();
    });
  }
  
  if (ipFilter) {
    ipFilter.addEventListener('change', function() {
      currentPage = 1;
      loadLogs();
    });
  }
  
  // 关闭模态框
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', function() {
      logModal.style.display = 'none';
    });
  }
  
  // 点击其他区域关闭模态框
  window.addEventListener('click', function(event) {
    if (event.target === logModal) {
      logModal.style.display = 'none';
    }
  });
  
  // 加载日志数据
  function loadLogs() {
    const searchQuery = searchInput ? searchInput.value : '';
    const statusValue = statusFilter ? statusFilter.value : '';
    const ipValue = ipFilter ? ipFilter.value : '';
    
    // 构建API URL
    let url = `/api/logs?page=${currentPage}&limit=${itemsPerPage}`;
    if (searchQuery) {
      url += `&search=${encodeURIComponent(searchQuery)}`;
    }
    if (statusValue) {
      url += `&status=${statusValue}`;
    }
    if (ipValue) {
      url += `&ip=${encodeURIComponent(ipValue)}`;
    }
    
    // 显示加载指示器
    if (logsTable) {
      logsTable.innerHTML = '<tr><td colspan="6" style="text-align: center;">加载中...</td></tr>';
    }
    
    fetch(url)
      .then(response => response.json())
      .then(data => {
        if (logsTable) {
          renderLogs(data.data);
        }
        if (paginationContainer) {
          renderPagination(data.pagination);
        }
        
        // 更新IP过滤选项
        updateIPOptions(data.data);
      })
      .catch(error => {
        console.error('获取日志数据出错:', error);
        if (logsTable) {
          logsTable.innerHTML = '<tr><td colspan="6" style="text-align: center;">加载日志数据出错</td></tr>';
        }
      });
  }
  
  // 渲染日志表格
  function renderLogs(logs) {
    if (!logsTable) return;
    
    if (!logs || logs.length === 0) {
      logsTable.innerHTML = '<tr><td colspan="6" style="text-align: center;">没有找到匹配的日志记录</td></tr>';
      return;
    }
    
    let tableHtml = `
      <tr>
        <th>请求ID</th>
        <th>客户端IP</th>
        <th>请求路径</th>
        <th>状态</th>
        <th>响应时间</th>
        <th>时间</th>
      </tr>
    `;
    
    logs.forEach(log => {
      const isSuccess = log.response_status >= 200 && log.response_status < 400;
      const statusClass = isSuccess ? 'status-success' : 'status-error';
      
      tableHtml += `
        <tr data-log-id="${log.request_id}" class="log-row">
          <td>${log.request_id.substring(0, 12)}...</td>
          <td>${log.client_ip}</td>
          <td>${log.request_path.length > 30 ? log.request_path.substring(0, 30) + '...' : log.request_path}</td>
          <td class="${statusClass}">${log.response_status}</td>
          <td>${log.response_time}ms</td>
          <td>${new Date(log.created_at).toLocaleString()}</td>
        </tr>
      `;
    });
    
    logsTable.innerHTML = tableHtml;
    
    // 添加点击事件，显示详情
    const logRows = document.querySelectorAll('.log-row');
    logRows.forEach(row => {
      row.addEventListener('click', function() {
        const logId = this.getAttribute('data-log-id');
        showLogDetails(logs.find(log => log.request_id === logId));
      });
    });
  }
  
  // 显示日志详情
  function showLogDetails(log) {
    if (!logModal || !modalContent || !log) return;
    
    try {
      const requestHeaders = typeof log.request_headers === 'string' ? JSON.parse(log.request_headers) : log.request_headers;
      const responseHeaders = typeof log.response_headers === 'string' ? JSON.parse(log.response_headers) : log.response_headers;
      
      let requestBody = '';
      try {
        if (log.request_body) {
          const parsedBody = JSON.parse(log.request_body);
          requestBody = JSON.stringify(parsedBody, null, 2);
        }
      } catch (e) {
        requestBody = log.request_body || '';
      }
      
      let responseBody = '';
      try {
        if (log.response_body) {
          const parsedBody = JSON.parse(log.response_body);
          responseBody = JSON.stringify(parsedBody, null, 2);
        }
      } catch (e) {
        responseBody = log.response_body || '';
      }
      
      const modalHtml = `
        <div class="modal-header">
          <h3 class="modal-title">请求详情: ${log.request_id}</h3>
          <span class="close-modal">&times;</span>
        </div>
        
        <div class="modal-body">
          <div class="detail-item">
            <div class="detail-label">基本信息</div>
            <div class="detail-value">
              <p><strong>客户端IP:</strong> ${log.client_ip}</p>
              <p><strong>请求方法:</strong> ${log.request_method}</p>
              <p><strong>请求路径:</strong> ${log.request_path}</p>
              <p><strong>状态码:</strong> ${log.response_status}</p>
              <p><strong>响应时间:</strong> ${log.response_time}ms</p>
              <p><strong>创建时间:</strong> ${new Date(log.created_at).toLocaleString()}</p>
              <p><strong>用户代理:</strong> ${log.user_agent || 'N/A'}</p>
            </div>
          </div>
          
          <div class="detail-item">
            <div class="detail-label">请求头</div>
            <div class="detail-value"><pre>${JSON.stringify(requestHeaders, null, 2)}</pre></div>
          </div>
          
          <div class="detail-item">
            <div class="detail-label">请求体</div>
            <div class="detail-value"><pre>${requestBody || '无请求体'}</pre></div>
          </div>
          
          <div class="detail-item">
            <div class="detail-label">响应头</div>
            <div class="detail-value"><pre>${JSON.stringify(responseHeaders, null, 2)}</pre></div>
          </div>
          
          <div class="detail-item">
            <div class="detail-label">响应体</div>
            <div class="detail-value"><pre>${responseBody || '无响应体'}</pre></div>
          </div>
          
          ${log.error_message ? `
          <div class="detail-item">
            <div class="detail-label">错误信息</div>
            <div class="detail-value">${log.error_message}</div>
          </div>
          ` : ''}
        </div>
      `;
      
      modalContent.innerHTML = modalHtml;
      logModal.style.display = 'block';
      
      // 重新绑定关闭按钮事件
      const newCloseBtn = modalContent.querySelector('.close-modal');
      if (newCloseBtn) {
        newCloseBtn.addEventListener('click', function() {
          logModal.style.display = 'none';
        });
      }
    } catch (error) {
      console.error('显示日志详情出错:', error);
    }
  }
  
  // 渲染分页
  function renderPagination(pagination) {
    if (!paginationContainer || !pagination) return;
    
    totalPages = pagination.pages;
    
    let paginationHtml = '';
    
    // 上一页按钮
    paginationHtml += `<button ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">上一页</button>`;
    
    // 页码按钮
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(startPage + 4, totalPages);
    
    if (endPage - startPage < 4 && totalPages > 4) {
      startPage = Math.max(1, endPage - 4);
    }
    
    for (let i = startPage; i <= endPage; i++) {
      paginationHtml += `<button ${i === currentPage ? 'class="active"' : ''} data-page="${i}">${i}</button>`;
    }
    
    // 下一页按钮
    paginationHtml += `<button ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">下一页</button>`;
    
    paginationContainer.innerHTML = paginationHtml;
    
    // 添加页码按钮点击事件
    const pageButtons = paginationContainer.querySelectorAll('button:not([disabled])');
    pageButtons.forEach(button => {
      button.addEventListener('click', function() {
        currentPage = parseInt(this.getAttribute('data-page'));
        loadLogs();
      });
    });
  }
  
  // 更新IP过滤选项
  function updateIPOptions(logs) {
    if (!ipFilter) return;
    
    // 保存当前选中的值
    const currentValue = ipFilter.value;
    
    // 获取所有唯一的IP地址
    const uniqueIps = [...new Set(logs.map(log => log.client_ip))];
    
    // 清除旧选项
    while (ipFilter.options.length > 1) {
      ipFilter.remove(1);
    }
    
    // 添加新选项
    uniqueIps.forEach(ip => {
      const option = document.createElement('option');
      option.value = ip;
      option.textContent = ip;
      ipFilter.appendChild(option);
    });
    
    // 恢复选中的值
    if (currentValue && uniqueIps.includes(currentValue)) {
      ipFilter.value = currentValue;
    }
  }
  
  // 防抖函数
  function debounce(func, wait) {
    let timeout;
    return function() {
      const context = this;
      const args = arguments;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        func.apply(context, args);
      }, wait);
    };
  }
}); 