// backend/server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

// ====== CORS CHO FRONTEND VERCEL ======
const ALLOWED_ORIGINS = [
  "https://chat-socket-g8.vercel.app",
  "http://localhost:5500",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Cho phép đọc JSON nếu cần
app.use(express.json());

// ====== UPLOAD FILE (ảnh / file / voice) ======
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});

const upload = multer({ storage });

app.use("/uploads", express.static(uploadDir));

// ====== IN-MEMORY DATA (ROOM, USER, MESSAGE) ======
const DEFAULT_ROOM = "general";

// socket.id -> { username, rooms: Set<string> }
const sockets = new Map();

// username -> socket.id
const usernameToSocket = new Map();

// roomName -> { messages: Array<Message> }
const rooms = new Map();
rooms.set(DEFAULT_ROOM, { messages: [] });

let nextMessageId = 1;

function getOnlineUsers() {
  return Array.from(usernameToSocket.keys());
}

function emitUsersOnline() {
  const list = getOnlineUsers();
  io.emit("users_online", list);
}

function ensureRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, { messages: [] });
  }
  return rooms.get(room);
}

function createMessage({
  room,
  sender,
  content,
  isPrivate = false,
  system = false,
}) {
  return {
    _id: String(nextMessageId++),
    room,
    sender,
    content,
    createdAt: Date.now(),
    isPrivate,
    system,
    readBy: [],
  };
}

// ====== ROUTES ======

// Để test server sống
app.get("/", (req, res) => {
  res.send("Socket.IO chat backend is running");
});

// Lịch sử tin nhắn theo room
app.get("/api/rooms/:room/messages", (req, res) => {
  const room = req.params.room;
  const limit = parseInt(req.query.limit || "50", 10);

  const roomData = rooms.get(room);
  if (!roomData) return res.json([]);

  const msgs = roomData.messages.slice(-limit);
  res.json(msgs);
});

// Upload file (ảnh / file bất kỳ / voice)
app.post("/upload-file", upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    const { room, username } = req.body;

    if (!file || !room || !username) {
      return res.status(400).json({
        ok: false,
        message: "Thiếu file / room / username",
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const fileUrl = `${baseUrl}/uploads/${file.filename}`;
    const timestamp = Date.now();

    // Bắn sự kiện fileMessage cho các client trong room
    io.to(room).emit("fileMessage", {
      username,
      url: fileUrl,
      original: file.originalname,
      size: file.size,
      timestamp,
    });

    // Nếu muốn lưu vào lịch sử text của room (tuỳ, không bắt buộc)
    const roomData = ensureRoom(room);
    const msg = createMessage({
      room,
      sender: username,
      content: `(Đã gửi file: ${file.originalname})`,
      isPrivate: false,
      system: false,
    });
    roomData.messages.push(msg);

    return res.json({
      ok: true,
      url: fileUrl,
      original: file.originalname,
      size: file.size,
      timestamp,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ ok: false, message: "Lỗi upload file" });
  }
});

// ====== SOCKET.IO ======
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // ====== SET USERNAME ======
  socket.on("set_username", (name, cb) => {
    try {
      const username = String(name || "").trim();
      if (!username) {
        return cb({ ok: false, error: "Tên không hợp lệ" });
      }

      const existing = usernameToSocket.get(username);
      if (existing && existing !== socket.id) {
        return cb({ ok: false, error: "Tên đã có người dùng" });
      }

      // Gán vào socket
      socket.data.username = username;
      sockets.set(socket.id, { username, rooms: new Set() });
      usernameToSocket.set(username, socket.id);

      // Tự join room mặc định
      socket.join(DEFAULT_ROOM);
      sockets.get(socket.id).rooms.add(DEFAULT_ROOM);

      const allRooms = Array.from(rooms.keys());

      cb({
        ok: true,
        rooms: allRooms,
        usersOnline: getOnlineUsers(),
      });

      emitUsersOnline();
      console.log(`User set_username: ${username}`);
    } catch (err) {
      console.error(err);
      cb({ ok: false, error: "Lỗi server" });
    }
  });

  // ====== JOIN ROOM ======
  socket.on("join_room", (room, cb) => {
    const username = socket.data.username;
    if (!username) return cb && cb({ ok: false, error: "Chưa đăng nhập" });

    const roomName = String(room || "").trim();
    if (!roomName) return cb && cb({ ok: false, error: "Tên phòng không hợp lệ" });

    socket.join(roomName);
    const state = sockets.get(socket.id);
    if (state) state.rooms.add(roomName);

    const roomData = ensureRoom(roomName);

    // Thông báo hệ thống cho các user khác
    socket.to(roomName).emit(
      "system",
      `${username} đã tham gia phòng ${roomName}`
    );

    cb &&
      cb({
        ok: true,
        history: roomData.messages.slice(-50),
      });
  });

  // ====== CHAT PHÒNG ======
  socket.on("chat_message", (payload, cb) => {
    try {
      const username = socket.data.username;
      if (!username) return cb && cb({ ok: false, error: "Chưa đăng nhập" });

      const room = payload?.room || DEFAULT_ROOM;
      const content = String(payload?.content || "").trim();
      if (!content) return cb && cb({ ok: false, error: "Nội dung trống" });

      const roomData = ensureRoom(room);

      const msg = createMessage({
        room,
        sender: username,
        content,
        isPrivate: false,
        system: false,
      });

      roomData.messages.push(msg);
      io.to(room).emit("chat_message", msg);

      cb && cb({ ok: true, id: msg._id });
    } catch (err) {
      console.error(err);
      cb && cb({ ok: false, error: "Lỗi server" });
    }
  });

  // ====== CHAT RIÊNG (DM) ======
  socket.on("private_message", (payload, cb) => {
    try {
      const fromUser = socket.data.username;
      if (!fromUser) return cb && cb({ ok: false, error: "Chưa đăng nhập" });

      const toUser = payload?.to;
      const content = String(payload?.content || "").trim();
      if (!toUser || !content)
        return cb && cb({ ok: false, error: "Thiếu người nhận hoặc nội dung" });

      const targetSocketId = usernameToSocket.get(toUser);
      if (!targetSocketId) {
        return cb && cb({ ok: false, error: "Người nhận không online" });
      }

      const msg = {
        _id: String(nextMessageId++),
        room: null,
        sender: fromUser,
        content,
        createdAt: Date.now(),
        isPrivate: true,
        system: false,
        readBy: [],
      };

      // Gửi cho người gửi
      io.to(socket.id).emit("private_message", msg);

      // Gửi cho người nhận
      io.to(targetSocketId).emit("private_message", msg);

      cb && cb({ ok: true, id: msg._id });
    } catch (err) {
      console.error(err);
      cb && cb({ ok: false, error: "Lỗi server" });
    }
  });

  // ====== TYPING ======
  socket.on("typing", ({ room, isTyping }) => {
    const username = socket.data.username;
    if (!username || !room) return;
    socket.to(room).emit("typing", {
      room,
      username,
      isTyping: !!isTyping,
    });
  });

  // ====== ĐÁNH DẤU ĐÃ XEM ======
  socket.on("message_read", ({ messageId }) => {
    try {
      const reader = socket.data.username;
      if (!reader || !messageId) return;

      for (const [, roomData] of rooms) {
        const msg = roomData.messages.find((m) => m._id === String(messageId));
        if (msg) {
          if (!msg.readBy.includes(reader)) {
            msg.readBy.push(reader);
          }
          const senderSocketId = usernameToSocket.get(msg.sender);
          if (senderSocketId) {
            io.to(senderSocketId).emit("message_read", { messageId: msg._id });
          }
          break;
        }
      }
    } catch (err) {
      console.error("message_read error:", err);
    }
  });

  // ====== SIGNALING CHO CALL (WEBRTC) ======
  socket.on("call_user", ({ to, offer, isVideo }) => {
    const fromUser = socket.data.username;
    if (!fromUser || !to) return;

    const targetSocketId = usernameToSocket.get(to);
    if (!targetSocketId) return;

    io.to(targetSocketId).emit("incoming_call", {
      from: fromUser,
      offer,
      isVideo: !!isVideo,
    });
  });

  socket.on("answer_call", ({ to, answer }) => {
    const fromUser = socket.data.username;
    if (!fromUser || !to) return;
    const targetSocketId = usernameToSocket.get(to);
    if (!targetSocketId) return;

    io.to(targetSocketId).emit("call_answered", {
      from: fromUser,
      answer,
    });
  });

  socket.on("reject_call", ({ to, reason }) => {
    const fromUser = socket.data.username;
    if (!fromUser || !to) return;
    const targetSocketId = usernameToSocket.get(to);
    if (!targetSocketId) return;

    io.to(targetSocketId).emit("call_rejected", {
      from: fromUser,
      reason: reason || "rejected",
    });
  });

  socket.on("end_call", ({ to }) => {
    const fromUser = socket.data.username;
    if (!fromUser || !to) return;
    const targetSocketId = usernameToSocket.get(to);
    if (!targetSocketId) return;

    io.to(targetSocketId).emit("call_ended", { from: fromUser });
  });

  socket.on("ice_candidate", ({ to, candidate }) => {
    const fromUser = socket.data.username;
    if (!fromUser || !to || !candidate) return;
    const targetSocketId = usernameToSocket.get(to);
    if (!targetSocketId) return;

    io.to(targetSocketId).emit("ice_candidate", {
      from: fromUser,
      candidate,
    });
  });

  // ====== NGẮT KẾT NỐI ======
  socket.on("disconnect", () => {
    const state = sockets.get(socket.id);
    if (state) {
      console.log("User disconnected:", state.username);

      usernameToSocket.delete(state.username);
      sockets.delete(socket.id);
      emitUsersOnline();

      // Có thể bắn system nếu muốn
      // state.rooms.forEach(room => {
      //   socket.to(room).emit("system", `${state.username} đã rời phòng`);
      // });
    } else {
      console.log("Socket disconnected:", socket.id);
    }
  });
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
