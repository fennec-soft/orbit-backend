const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

const verificationCodes = {};

// إعداد Nodemailer مع كلمة المرور الجديدة
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'info.fennec.soft@gmail.com',
        pass: 'ljiqctpbhebuvctm'
    }
});

// فحص الاتصال بسيرفر الجيميل فور تشغيل السيرفر
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ خطأ في الاتصال بسيرفر الجيميل:', error.message);
    } else {
        console.log('✅ تم الاتصال بسيرفر الجيميل بنجاح! جاهز لإرسال الرسائل.');
    }
});

// 1. مسار إرسال كود التفعيل
app.post('/api/send-code', async (req, res) => {
    const { name, email } = req.body;
    if (!email || !name) return res.status(400).send({ error: 'البيانات غير مكتملة' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes[email] = code;

    console.log(`\n🔑 [كود التفعيل للتجربة]: ${code}`);

    try {
        const info = await transporter.sendMail({
            from: '"Orbit" <info.fennec.soft@gmail.com>',
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

// 2. مسار التحقق من الكود
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;
    if (verificationCodes[email] && verificationCodes[email] === code) {
        delete verificationCodes[email];
        res.status(200).send({ message: 'تم التحقق بنجاح' });
    } else {
        res.status(400).send({ error: 'الكود غير صحيح' });
    }
});

// --- إعدادات Socket.io للمكالمات والمحادثة ---
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

server.listen(3000, () => console.log('Server running on port 3000'));