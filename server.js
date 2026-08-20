const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// كود التفعيل: { email: { code, name, expiresAt, attempts } }
const verificationCodes = {};
// جلسات المستخدمين بعد نجاح التحقق: { token: { email, name, expiresAt } }
const sessions = {};
// آخر وقت طلب كود لكل بريد (لمنع الإغراق): { email: timestamp }
const lastSendAt = {};

const CODE_TTL_MS = 10 * 60 * 1000;       // صلاحية الكود: 10 دقائق
const MAX_VERIFY_ATTEMPTS = 5;             // أقصى عدد محاولات خاطئة
const SEND_COOLDOWN_MS = 60 * 1000;        // طلب كود جديد كل 60 ثانية كحد أدنى
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // صلاحية جلسة الدخول: 7 أيام

// تنظيف دوري للأكواد والجلسات المنتهية لمنع تراكمها في الذاكرة
setInterval(() => {
    const now = Date.now();
    for (const email in verificationCodes) {
        if (now > verificationCodes[email].expiresAt) delete verificationCodes[email];
    }
    for (const token in sessions) {
        if (now > sessions[token].expiresAt) delete sessions[token];
    }
}, 5 * 60 * 1000);

// قراءة بيانات البريد الإلكتروني من متغيرات البيئة فقط - لا قيم افتراضية مطلقًا
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

if (!GMAIL_USER || !GMAIL_PASS) {
    console.error('❌ يجب ضبط متغيرات البيئة GMAIL_USER و GMAIL_PASS قبل تشغيل السيرفر.');
    console.error('   مثال: GMAIL_USER=you@gmail.com GMAIL_PASS=app_password node server.js');
    process.exit(1);
}

// إعداد Nodemailer[cite: 2]
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
    }
});

// فحص الاتصال بسيرفر الجيميل[cite: 2]
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ خطأ في الاتصال بسيرفر الجيميل:', error.message);
    } else {
        console.log('✅ تم الاتصال بسيرفر الجيميل بنجاح! جاهز لإرسال الرسائل.');
    }
});

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 1. مسار إرسال كود التفعيل[cite: 2]
app.post('/api/send-code', async (req, res) => {
    const { name, email } = req.body;
    if (!email || !name) return res.status(400).send({ error: 'البيانات غير مكتملة' });
    if (!emailRegex.test(email)) return res.status(400).send({ error: 'بريد إلكتروني غير صالح' });

    const now = Date.now();
    const last = lastSendAt[email];
    if (last && now - last < SEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((SEND_COOLDOWN_MS - (now - last)) / 1000);
        return res.status(429).send({ error: `يرجى الانتظار ${waitSec} ثانية قبل طلب كود جديد` });
    }

    // استخدام مولد عشوائي آمن تشفيريًا بدل Math.random
    const code = crypto.randomInt(100000, 1000000).toString();
    verificationCodes[email] = { code, name, expiresAt: now + CODE_TTL_MS, attempts: 0 };
    lastSendAt[email] = now;

    console.log(`\n🔑 [كود التفعيل للتجربة]: ${code}`);

    try {
        const info = await transporter.sendMail({
            from: `"Orbit" <${GMAIL_USER}>`,
            to: email,
            subject: 'كود تفعيل حسابك - Orbit',
            html: `
              <div style="direction: rtl; font-family: sans-serif; padding: 20px; background: #f4f4f4;">
                <h2>مرحباً ${name}،</h2>
                <p>كود التفعيل الخاص بك لتطبيق Orbit هو:</p>
                <h1 style="color: #0097b2; letter-spacing: 5px;">${code}</h1>
              </div>
            `
        });

        console.log('📧 تم إرسال البريد بنجاح! Message ID:', info.messageId);
        res.status(200).send({ message: 'تم إرسال الكود إلى بريدك الإلكتروني' });

    } catch (error) {
        console.error('❌ فشل إرسال البريد عبر Nodemailer:', error);
        res.status(500).send({ error: 'تعذر إرسال البريد، يرجى مراجعة التيرمينال' });
    }
});

// 2. مسار التحقق من الكود[cite: 2]
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;
    const entry = verificationCodes[email];

    if (!entry) {
        return res.status(400).send({ error: 'لم يتم طلب كود لهذا البريد، يرجى طلب كود جديد' });
    }

    if (Date.now() > entry.expiresAt) {
        delete verificationCodes[email];
        return res.status(400).send({ error: 'انتهت صلاحية الكود، يرجى طلب كود جديد' });
    }

    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
        delete verificationCodes[email];
        return res.status(429).send({ error: 'محاولات كثيرة جدًا، يرجى طلب كود جديد' });
    }

    if (entry.code !== code) {
        entry.attempts += 1;
        return res.status(400).send({ error: 'الكود غير صحيح' });
    }

    // نجاح التحقق: إصدار توكن جلسة حقيقي بدل الاكتفاء برسالة نجاح
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { email, name: entry.name, expiresAt: Date.now() + SESSION_TTL_MS };
    delete verificationCodes[email];

    res.status(200).send({
        message: 'تم التحقق بنجاح',
        token,
        user: { name: entry.name, email }
    });
});

// 3. مسار التحقق من صلاحية جلسة الدخول (يُستدعى عند فتح التطبيق)
app.post('/api/verify-token', (req, res) => {
    const { token } = req.body;
    const session = token ? sessions[token] : null;

    if (!session || Date.now() > session.expiresAt) {
        if (session) delete sessions[token];
        return res.status(401).send({ error: 'الجلسة غير صالحة، يرجى تسجيل الدخول من جديد' });
    }

    res.status(200).send({ user: { name: session.name, email: session.email } });
});

// --- إعدادات Socket.io للمكالمات والمحادثة ---[cite: 2]
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    socket.to(roomId).emit('user-connected', { userId: socket.id, userName });

    socket.on('send-chat', (text) => {
      socket.to(socket.roomId).emit('receive-chat', {
        sender: socket.userName || 'مستخدم',
        text: text,
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
      });
    });

    socket.on('offer', (data) => {
      socket.to(data.target).emit('offer', { signal: data.signal, caller: socket.id, userName: socket.userName });
    });

    socket.on('answer', (data) => {
      socket.to(data.target).emit('answer', { signal: data.signal, id: socket.id });
    });

    socket.on('ice-candidate', (data) => {
      socket.to(data.target).emit('ice-candidate', { candidate: data.candidate, id: socket.id });
    });

    socket.on('toggle-cam', (isOff) => {
      socket.to(roomId).emit('user-cam-toggled', { userId: socket.id, isOff });
    });

    socket.on('raise-hand', () => {
      socket.to(roomId).emit('user-raised-hand', socket.userName);
    });

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', socket.id);
    });
  });
});

// استخدام المنفذ الديناميكي المخصص للسحابة والاستماع على جميع العناوين المتاحة[cite: 2]
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
