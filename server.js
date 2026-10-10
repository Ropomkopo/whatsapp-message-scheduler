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

const sessions = new Map(); // Store active whatsapp clients
const cronJobs = new Map(); // Store active cron jobs { sessionId: [jobs] }

// Ensure sessions directory exists
const sessionsDir = path.join(__dirname, '.sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir);
}

// Helper to get tasks path for a session
const getTasksPath = (sessionId) => path.join(sessionsDir, `${sessionId}_tasks.json`);

// Load tasks for a session
const loadTasks = (sessionId) => {
  const tasksPath = getTasksPath(sessionId);
  if (fs.existsSync(tasksPath)) {
    return JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  }
  return [];
};

// Save tasks for a session
const saveTasks = (sessionId, tasks) => {
  fs.writeFileSync(getTasksPath(sessionId), JSON.stringify(tasks, null, 2));
};

// Start a WhatsApp client for a session
const startClient = (sessionId, socket) => {
  if (sessions.has(sessionId)) {
    const client = sessions.get(sessionId);
    client.getState().then(state => {
       if (state === 'CONNECTED') {
         socket.emit('ready', { message: 'WhatsApp is connected!' });
       } else {
         // Not connected but session exists (user probably refreshed while waiting for QR).
         // Force a fresh client start so they can get a new QR code.
         client.destroy().catch(() => {});
         sessions.delete(sessionId);
         startClient(sessionId, socket);
       }
    }).catch(() => {
       client.destroy().catch(() => {});
       sessions.delete(sessionId);
       startClient(sessionId, socket);
    });
    return;
  }

  console.log(`Starting client for session: ${sessionId}`);
  socket.emit('status', 'Initializing WhatsApp Client...');

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: './.sessions'
    }),
    puppeteer: {
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log(`[${sessionId}] QR received`);
    socket.emit('qr', qr);
  });

  client.on('ready', () => {
    console.log(`[${sessionId}] Client is ready!`);
    socket.emit('ready', { message: 'WhatsApp is connected!' });
    // Initialize saved cron jobs
    startCronJobs(sessionId, client);
  });

  client.on('authenticated', () => {
    console.log(`[${sessionId}] Authenticated!`);
    socket.emit('status', 'Authenticated, loading chats...');
  });

  client.on('auth_failure', msg => {
    console.error(`[${sessionId}] Authentication failure`, msg);
    socket.emit('error', 'Authentication failed');
  });

  client.on('disconnected', (reason) => {
    console.log(`[${sessionId}] Client was disconnected`, reason);
    socket.emit('disconnected', 'WhatsApp disconnected');
    client.destroy().catch(e => console.error('Error destroying client:', e));
    sessions.delete(sessionId);
    stopCronJobs(sessionId);
    
    // Очищуємо папку сесії, щоб наступного разу згенерувався новий QR
    try {
      const sessionFolder = path.join(sessionsDir, `session-${sessionId}`);
      if (fs.existsSync(sessionFolder)) {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[${sessionId}] Failed to remove session folder:`, err);
    }
  });

  client.initialize();
  sessions.set(sessionId, client);
};

// Stop existing cron jobs for a session
const stopCronJobs = (sessionId) => {
  if (cronJobs.has(sessionId)) {
    cronJobs.get(sessionId).forEach(job => job.stop());
    cronJobs.delete(sessionId);
  }
};

// Start all cron jobs for a session
const startCronJobs = (sessionId, client) => {
  stopCronJobs(sessionId); // Stop any old jobs first
  const tasks = loadTasks(sessionId);
  const jobs = [];

  tasks.forEach((task, index) => {
    if (!cron.validate(task.cron)) return;
    
    const cleanPhone = task.phone.replace(/\D/g, '');
    const chatId = `${cleanPhone}@c.us`;

    const job = cron.schedule(task.cron, async () => {
      console.log(`[${sessionId}] Sending scheduled message to +${cleanPhone}`);
      try {
        await client.sendMessage(chatId, task.message);
      } catch (err) {
        console.error(`[${sessionId}] Failed to send message to +${cleanPhone}`, err);
      }
    });
    jobs.push(job);
  });

  cronJobs.set(sessionId, jobs);
  console.log(`[${sessionId}] Started ${jobs.length} scheduled tasks.`);
};


// WebSockets for Real-time communication
io.on('connection', (socket) => {
  console.log('A user connected via socket');

  socket.on('start_session', (sessionId) => {
    if (!sessionId) return;
    socket.join(sessionId); // Join a room for this session
    startClient(sessionId, socket);
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

  const tasks = loadTasks(sessionId);
  const newTask = { id: Date.now().toString(), phone, cron: cronExp, message };
  tasks.push(newTask);
  saveTasks(sessionId, tasks);

  // Restart cron jobs to include the new one
  if (sessions.has(sessionId)) {
    startCronJobs(sessionId, sessions.get(sessionId));
  }

  res.json(newTask);
});

app.delete('/api/tasks/:id', (req, res) => {
  const sessionId = req.query.sessionId;
  const taskId = req.params.id;
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });

  let tasks = loadTasks(sessionId);
  tasks = tasks.filter(t => t.id !== taskId);
  saveTasks(sessionId, tasks);

  if (sessions.has(sessionId)) {
    startCronJobs(sessionId, sessions.get(sessionId));
  }

  res.json({ success: true });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
