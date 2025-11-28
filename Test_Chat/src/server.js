import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Server } from 'socket.io';
import { connectDB } from './db.js';
import { createSocket } from './socket.js';
import { Message } from './models/Message.js';

// 1. Khởi tạo App và Server trước
const app = express();
const server = http.createServer(app);

// 2. Khởi tạo IO ngay tại đây để các route bên dưới có thể sử dụng
const io = new Server(server, { 
    cors: { origin: '*' } 
});

// 3. Cấu hình Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 4. Cấu hình Upload file (Multer)
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Tự động tạo thư mục uploads nếu chưa có
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Đặt tên file chống trùng: thời-gian + số-ngẫu-nhiên + đuôi-file
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + unique + ext);
  }
});

const upload = multer({ storage });

// Mở quyền truy cập công khai cho thư mục uploads
app.use('/uploads', express.static(UPLOAD_DIR));

// 5. Các API Routes
app.get('/api/rooms/:room/messages', async (req, res) => {
  try {
      const { room } = req.params;
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const docs = await Message.find({ room, isPrivate: false }).sort({ createdAt: -1 }).limit(limit).lean();
      res.json(docs.reverse());
  } catch (e) {
      res.status(500).json([]);
  }
});

app.get('/api/dm/:a/:b', async (req, res) => {
  try {
      const { a, b } = req.params;
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
      const docs = await Message.find({
        isPrivate: true,
        $or: [
          { sender: a, to: b },
          { sender: b, to: a }
        ]
      }).sort({ createdAt: -1 }).limit(limit).lean();
      res.json(docs.reverse());
  } catch (e) {
      res.status(500).json([]);
  }
});

// 📤 ROUTE UPLOAD QUAN TRỌNG (Đã tích hợp Socket IO)
app.post('/upload-file', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    // Lấy thêm thông tin room và username từ body gửi lên
    const { room, username } = req.body; 
    
    if (!file) {
      return res.status(400).json({ ok: false, message: 'Không có file nào được gửi lên' });
    }

    // Tạo đường dẫn truy cập file
    const fileUrl = `/uploads/${file.filename}`;
    
    // --- TÍNH NĂNG MỚI: Server tự bắn Socket cho cả phòng ---
    // Nếu client gửi kèm tên phòng, server sẽ báo cho mọi người trong phòng đó biết ngay lập tức
    if (room) {
      const messageData = {
        username: username || 'Ẩn danh',
        url: fileUrl,
        original: file.originalname,
        size: file.size,
        timestamp: Date.now(),
        room: room
      };

      // Gửi sự kiện 'fileMessage' tới tất cả user trong phòng 'room'
      io.to(room).emit('fileMessage', messageData);
      
      // (Tùy chọn) Nếu bạn muốn lưu tin nhắn file vào Database luôn thì viết code lưu DB ở đây
    }
    
    // Trả về JSON cho người upload biết là thành công
    return res.json({ 
        ok: true, 
        url: fileUrl, 
        filename: file.filename,
        original: file.originalname,
        size: file.size
    });

  } catch (err) {
    console.error('Upload error:', err);
    // Quan trọng: Trả về JSON lỗi chứ không để crash
    return res.status(500).json({ ok: false, message: 'Lỗi server khi upload' });
  }
});

// 6. Khởi chạy Socket Logic (tách biệt logic chat thường)
createSocket(io);

// 7. Kết nối DB và Chạy Server
const PORT = process.env.PORT || 3000;
connectDB(process.env.MONGO_URL).then(() => {
  server.listen(PORT, () => {
    console.log('🚀 Server listening on http://localhost:' + PORT);
    console.log('📂 Upload folder ready at: ' + UPLOAD_DIR);
  });
}).catch(err => {
    console.error("❌ Lỗi kết nối DB:", err);
});
