const socket = io();

// Get or generate a unique Session ID for the browser
let sessionId = localStorage.getItem('wa_session_id');
if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('wa_session_id', sessionId);
}

// DOM Elements
const statusBadge = document.getElementById('status-badge');
const qrContainer = document.getElementById('qr-container');
const qrcodeDiv = document.getElementById('qrcode');
const qrLoader = document.getElementById('qr-loader');
const connectedState = document.getElementById('connected-state');
const overlay = document.getElementById('overlay');
const taskForm = document.getElementById('task-form');
const tasksList = document.getElementById('tasks-list');

// Initialize QR Code library
const qrCodeObj = new QRCode(qrcodeDiv, {
    width: 200,
    height: 200
});

// Connect to backend via Socket.io
socket.on('connect', () => {
    socket.emit('start_session', sessionId);
});

socket.on('status', (msg) => {
    statusBadge.textContent = msg;
    statusBadge.className = 'status-badge connecting';
});

socket.on('qr', (qrStr) => {
    statusBadge.textContent = 'Очікування сканування...';
    qrLoader.classList.add('hidden');
    qrcodeDiv.classList.remove('hidden');
    qrCodeObj.clear();
    qrCodeObj.makeCode(qrStr);
});

socket.on('ready', (data) => {
    statusBadge.textContent = 'Підключено';
    statusBadge.className = 'status-badge connected';
    
    // Switch UI to connected state
    qrContainer.classList.add('hidden');
    connectedState.classList.remove('hidden');
    
    // Unlock Task Form
    overlay.classList.add('hidden');

    // Load Tasks
    loadTasks();
});

const btnReconnect = document.getElementById('btn-reconnect');

socket.on('disconnected', () => {
    statusBadge.textContent = 'Відключено. Запросіть новий QR.';
    statusBadge.className = 'status-badge disconnected';
    qrContainer.classList.remove('hidden');
    connectedState.classList.add('hidden');
    overlay.classList.remove('hidden');
    qrLoader.classList.add('hidden');
    qrcodeDiv.classList.add('hidden');
    btnReconnect.classList.remove('hidden');
});

btnReconnect.addEventListener('click', () => {
    btnReconnect.classList.add('hidden');
    qrLoader.classList.remove('hidden');
    statusBadge.textContent = 'Генерація нового коду...';
    statusBadge.className = 'status-badge connecting';
    socket.emit('start_session', sessionId);
});

// API interactions
async function loadTasks() {
    try {
        const res = await fetch(`/api/tasks?sessionId=${sessionId}`);
        const tasks = await res.json();
        renderTasks(tasks);
    } catch (err) {
        console.error('Error loading tasks:', err);
    }
}

function renderTasks(tasks) {
    tasksList.innerHTML = '';
    if (tasks.length === 0) {
        tasksList.innerHTML = '<p style="color: #94a3b8; font-size: 0.9rem;">Ще немає запланованих завдань.</p>';
        return;
    }

    tasks.forEach(task => {
        const div = document.createElement('div');
        div.className = 'task-item';
        div.innerHTML = `
            <div class="task-details">
                <h4>📱 ${task.phone}</h4>
                <p>🕒 Cron: <strong>${task.cron}</strong></p>
                <div class="task-msg">${task.message}</div>
            </div>
            <button class="btn-delete" onclick="deleteTask('${task.id}')">Видалити</button>
        `;
        tasksList.appendChild(div);
    });
}

taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const phone = document.getElementById('phone').value;
    const cronStr = document.getElementById('cron').value;
    const message = document.getElementById('message').value;

    const btn = taskForm.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Збереження...';

    try {
        const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, phone, cron: cronStr, message })
        });
        
        const data = await res.json();
        if (data.error) {
            alert('Помилка: ' + data.error);
        } else {
            // Success
            taskForm.reset();
            loadTasks();
        }
    } catch (err) {
        alert('Помилка з\'єднання із сервером');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Запланувати відправку';
    }
});

async function deleteTask(id) {
    if (!confirm('Ви впевнені, що хочете видалити це завдання?')) return;
    
    try {
        await fetch(`/api/tasks/${id}?sessionId=${sessionId}`, { method: 'DELETE' });
        loadTasks();
    } catch (err) {
        console.error('Failed to delete task', err);
    }
}
