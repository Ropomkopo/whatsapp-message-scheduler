const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Запобігання падінню сервера через внутрішні помилки бібліотеки
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

app.use(express.static('public'));
app.use(express.json());

// Active sessions: sessionId -> { client, status, lastQr, isReady }
const sessions = new Map();
// Active cron jobs: sessionId -> [cronTasks]
const cronJobs = new Map();
// Set of session IDs currently undergoing initialization to prevent race conditions
const initializingSessions = new Set();

// Ensure sessions directory exists
const sessionsDir = path.join(__dirname, '.sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Clean stale Chromium lock files left behind by unexpected crashes
const cleanSessionLocks = (sessionId) => {
  const sessionFolder = path.join(sessionsDir, `session-${sessionId}`);
  if (!fs.existsSync(sessionFolder)) return;

  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
  for (const file of lockFiles) {
    const fullPath = path.join(sessionFolder, file);
    try {
      if (fs.existsSync(fullPath) || fs.lstatSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (_) {}
  }
};

// Clean all stale locks on startup
const cleanAllStaleLocks = () => {
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) {
        const folder = path.join(sessionsDir, entry.name);
        ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach((f) => {
          const fp = path.join(folder, f);
          try {
            if (fs.existsSync(fp) || fs.lstatSync(fp)) fs.unlinkSync(fp);
          } catch (_) {}
        });
      }
    }
  } catch (err) {
    console.error('Помилка очищення замків сесій:', err.message);
  }
};
cleanAllStaleLocks();

// Phone number normalization
const formatPhoneNumber = (phone) => {
  let cleaned = (phone || '').replace(/\D/g, '');
  if (cleaned.length === 10 && cleaned.startsWith('0')) {
    cleaned = '38' + cleaned;
  } else if (cleaned.length === 9) {
    cleaned = '380' + cleaned;
  }
  return cleaned;
};

// Helper to get tasks path for a session
const getTasksPath = (sessionId) => path.join(sessionsDir, `${sessionId}_tasks.json`);

// Load tasks for a session
const loadTasks = (sessionId) => {
  const tasksPath = getTasksPath(sessionId);
  if (fs.existsSync(tasksPath)) {
    try {
      return JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    } catch (e) {
      console.error(`[${sessionId}] Помилка читання файлу завдань:`, e.message);
    }
  }
  return [];
};

// Save tasks for a session
const saveTasks = (sessionId, tasks) => {
  fs.writeFileSync(getTasksPath(sessionId), JSON.stringify(tasks, null, 2));
};

// Stop existing cron jobs for a session
const stopCronJobs = (sessionId) => {
  if (cronJobs.has(sessionId)) {
    cronJobs.get(sessionId).forEach((job) => job.stop());
    cronJobs.delete(sessionId);
  }
};

// Start all cron jobs for a session
const startCronJobs = (sessionId) => {
  stopCronJobs(sessionId); // Stop any old jobs first
  const tasks = loadTasks(sessionId);
  const jobs = [];

  tasks.forEach((task, index) => {
    if (!cron.validate(task.cron)) return;

    const cleanPhone = formatPhoneNumber(task.phone);
    const defaultChatId = `${cleanPhone}@c.us`;

    const job = cron.schedule(task.cron, async () => {
      const now = new Date().toLocaleTimeString('uk-UA');
      console.log(`[${now}] [${sessionId}] Відправка запланованого повідомлення на +${cleanPhone}...`);

      const currentSession = sessions.get(sessionId);
      if (!currentSession || !currentSession.isReady || !currentSession.client) {
        console.warn(`[${sessionId}] Пропуск відправки: WhatsApp клієнт не готовий або не підключений.`);
        return;
      }

      const client = currentSession.client;

      try {
        let targetId = defaultChatId;
        try {
          const numberId = await client.getNumberId(cleanPhone);
          if (numberId && numberId._serialized) {
            targetId = numberId._serialized;
          }
        } catch (numErr) {
          console.warn(`[${sessionId}] Не вдалося перевірити getNumberId, надсилаємо на ${defaultChatId}`);
        }

        await client.sendMessage(targetId, task.message);
        console.log(`[${now}] [${sessionId}] Повідомлення успішно надіслано на ${targetId}!`);
      } catch (err) {
        console.error(`[${sessionId}] Помилка надсилання повідомлення на +${cleanPhone}:`, err.message);

        // Відновлення при detached Frame
        if (err.message && err.message.includes('detached Frame')) {
          console.warn(`[${sessionId}] Виявлено detached Frame. Спроба оновити контекст сторінки...`);
          try {
            if (client.pupPage && !client.pupPage.isClosed()) {
              await client.pupPage.reload({ waitUntil: 'networkidle0' });
            }
          } catch (reloadErr) {
            console.error(`[${sessionId}] Не вдалося перезавантажити сторінку:`, reloadErr.message);
          }
        }
      }
    });

    jobs.push(job);
  });

  cronJobs.set(sessionId, jobs);
  console.log(`[${sessionId}] Запущено ${jobs.length} запланованих завдань.`);
};

// Start a WhatsApp client for a session
const startClient = async (sessionId, socket) => {
  // If this session is already running
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (session.isReady) {
      socket.emit('ready', { message: 'WhatsApp is connected!' });
      return;
    }
    if (session.status === 'QR' && session.lastQr) {
      socket.emit('qr', session.lastQr);
      return;
    }
    if (session.status === 'AUTHENTICATED') {
      socket.emit('status', 'Авторизовано, завантаження чатів...');
      return;
    }
    if (session.status === 'INITIALIZING') {
      socket.emit('status', 'Ініціалізація клієнта WhatsApp...');
      return;
    }
    // If disconnected, clean up before starting fresh
    if (session.status === 'DISCONNECTED') {
      try {
        if (session.client) await session.client.destroy();
      } catch (_) {}
      sessions.delete(sessionId);
    }
  }

  // Prevent multiple simultaneous initializations for the same session
  if (initializingSessions.has(sessionId)) {
    socket.emit('status', 'Ініціалізація клієнта WhatsApp...');
    return;
  }

  initializingSessions.add(sessionId);
  cleanSessionLocks(sessionId);

  console.log(`Starting client for session: ${sessionId}`);
  socket.emit('status', 'Ініціалізація клієнта WhatsApp...');

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: './.sessions'
    }),
    puppeteer: {
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    }
  });

  const sessionObj = {
    client,
    status: 'INITIALIZING',
    lastQr: null,
    isReady: false
  };
  sessions.set(sessionId, sessionObj);

  client.on('qr', (qr) => {
    console.log(`[${sessionId}] QR received`);
    sessionObj.status = 'QR';
    sessionObj.lastQr = qr;
    io.to(sessionId).emit('qr', qr);
  });

  client.on('authenticated', () => {
    console.log(`[${sessionId}] Authenticated!`);
    sessionObj.status = 'AUTHENTICATED';
    sessionObj.lastQr = null;
    io.to(sessionId).emit('status', 'Авторизовано, завантаження чатів...');
  });

  client.on('ready', () => {
    console.log(`[${sessionId}] Client is ready!`);
    sessionObj.status = 'READY';
    sessionObj.isReady = true;
    sessionObj.lastQr = null;
    initializingSessions.delete(sessionId);
    io.to(sessionId).emit('ready', { message: 'WhatsApp is connected!' });
    // Initialize saved cron jobs
    startCronJobs(sessionId);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${sessionId}] Authentication failure`, msg);
    initializingSessions.delete(sessionId);
    io.to(sessionId).emit('error', 'Authentication failed');
  });

  client.on('disconnected', async (reason) => {
    console.log(`[${sessionId}] Client was disconnected`, reason);
    sessionObj.status = 'DISCONNECTED';
    sessionObj.isReady = false;
    initializingSessions.delete(sessionId);
    io.to(sessionId).emit('disconnected', 'WhatsApp disconnected');
    stopCronJobs(sessionId);

    try {
      await client.destroy();
    } catch (e) {
      console.error(`[${sessionId}] Error destroying client:`, e.message);
    }
    sessions.delete(sessionId);
    cleanSessionLocks(sessionId);

    // Clean session folder so next time fresh QR is generated
    try {
      const sessionFolder = path.join(sessionsDir, `session-${sessionId}`);
      if (fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[${sessionId}] Failed to remove session folder:`, err.message);
    }
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error(`[${sessionId}] Error initializing client:`, err.message);
    initializingSessions.delete(sessionId);
    sessions.delete(sessionId);
    cleanSessionLocks(sessionId);
    io.to(sessionId).emit('error', 'Не вдалося запустити WhatsApp: ' + err.message);
  }
};

// WebSockets for Real-time communication
io.on('connection', (socket) => {
  console.log('A user connected via socket');

  socket.on('start_session', async (sessionId) => {
    if (!sessionId) return;
    socket.join(sessionId); // Join a room for this session
    await startClient(sessionId, socket);
  });
});

// REST API for tasks
app.get('/api/tasks', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
  const tasks = loadTasks(sessionId);
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { sessionId, phone, cron: cronExp, message } = req.body;
  if (!sessionId || !phone || !cronExp || !message) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!cron.validate(cronExp)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const cleanPhone = formatPhoneNumber(phone);
  const displayPhone = cleanPhone.startsWith('380') ? `+${cleanPhone}` : phone;

  const tasks = loadTasks(sessionId);
  const newTask = { id: Date.now().toString(), phone: displayPhone, cron: cronExp, message };
  tasks.push(newTask);
  saveTasks(sessionId, tasks);

  // Restart cron jobs to include the new one if client is connected
  if (sessions.has(sessionId) && sessions.get(sessionId).isReady) {
    startCronJobs(sessionId);
  }

  res.json(newTask);
});

app.delete('/api/tasks/:id', (req, res) => {
  const sessionId = req.query.sessionId;
  const taskId = req.params.id;
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });

  let tasks = loadTasks(sessionId);
  tasks = tasks.filter((t) => t.id !== taskId);
  saveTasks(sessionId, tasks);

  if (sessions.has(sessionId) && sessions.get(sessionId).isReady) {
    startCronJobs(sessionId);
  }

  res.json({ success: true });
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\nЗупинка сервера...');
  for (const [sessionId, session] of sessions.entries()) {
    stopCronJobs(sessionId);
    if (session.client) {
      try {
        await session.client.destroy();
      } catch (_) {}
    }
    cleanSessionLocks(sessionId);
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
