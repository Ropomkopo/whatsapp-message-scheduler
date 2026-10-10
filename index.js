const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// 1. Зчитування завдань з tasks.json
const tasksPath = path.join(__dirname, 'tasks.json');
if (!fs.existsSync(tasksPath)) {
  console.error('Помилка: файл tasks.json не знайдено!');
  process.exit(1);
}

const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));

// 2. Ініціалізація клієнта зі збереженням сесії (папка .wwebjs_auth)
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// 3. Генерація QR-коду для першої авторизації
client.on('qr', (qr) => {
  console.log('\n--- ВІДСКАНУЙТЕ QR-КОД ЧЕРЕЗ WHATSAPP ---');
  qrcode.generate(qr, { small: true });
});

// 4. Подія готовності та планування відправки
client.on('ready', () => {
  console.log('\n[УСПІХ] Авторизація пройдена! WhatsApp підключено.');
  console.log(`Завантажено завдань: ${tasks.length}\n`);

  tasks.forEach((task, index) => {
    if (!cron.validate(task.cron)) {
      console.error(`[Помилка] Невірний формат cron у завданні #${index + 1}: ${task.cron}`);
      return;
    }

    const cleanPhone = task.phone.replace(/\D/g, '');
    const chatId = `${cleanPhone}@c.us`;

    // Реєстрація розкладу
    cron.schedule(task.cron, async () => {
      const now = new Date().toLocaleTimeString('uk-UA');
      console.log(`[${now}] Спроба відправки на номер +${cleanPhone}...`);

      try {
        await client.sendMessage(chatId, task.message);
        console.log(`[${now}] Успішно надіслано до +${cleanPhone}`);
      } catch (err) {
        console.error(`[${now}] Помилка надсилання до +${cleanPhone}:`, err.message);
      }
    });

    console.log(`[Заплановано #${index + 1}] Номер: +${cleanPhone} | Графік: "${task.cron}"`);
  });

  console.log('\nСкрипт перейшов у режим очікування потрібного часу. Не закривайте цей процес.');
});

client.on('auth_failure', (err) => {
  console.error('[Помилка автентифікації]:', err);
});

client.on('disconnected', (reason) => {
  console.warn('[Відключено]:', reason);
});

client.initialize();