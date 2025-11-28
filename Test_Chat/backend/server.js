const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

// Cho phép frontend Vercel gọi vào
app.use(cors({
  origin: ["https://chat-socket-g8.vercel.app"],
  methods: ["GET", "POST"],
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://chat-socket-g8.vercel.app"],
    methods: ["GET", "POST"],
  },
});

// Lắng nghe kết nối
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("send_message", (data) => {
    // xử lý logic chat của bạn
    io.emit("receive_message", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// PORT phải lấy từ biến môi trường khi chạy trên Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
