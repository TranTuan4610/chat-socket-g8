import { User } from './models/User.js';
import { Room } from './models/Room.js';
import { Message } from './models/Message.js';

export function createSocket(io) {
  const onlineUsers = new Map();   // username -> socketId
  const socketToUser = new Map();  // socketId -> username

  // Hàm đảm bảo phòng tồn tại trong DB
  async function ensureRoom(name) {
    if (!name) return;
    const existing = await Room.findOne({ name });
    if (!existing) {
      await Room.create({ name });
    }
  }

  // 🧹 Xoá phòng khi không còn ai
  async function clearRoomIfEmpty(room) {
    if (!room) return;
    const roomInfo = io.sockets.adapter.rooms.get(room);

    if (!roomInfo || roomInfo.size === 0) {
      console.log(`🧹 Xóa phòng vì không còn ai: ${room}`);
      // Xoá room trong DB
      await Room.deleteOne({ name: room });
      // Xoá tin nhắn public trong room
      await Message.deleteMany({ room, isPrivate: false });
      // Báo hệ thống (phòng hờ)
      io.emit('system', `Phòng ${room} đã bị xoá vì không còn người tham gia`);
    }
  }

  io.on('connection', (socket) => {
    console.log('🔌 Client connected', socket.id);

    // --- 1. ĐĂNG NHẬP (SET USERNAME) ---
    socket.on('set_username', async (username, ack) => {
      try {
        username = (username || '').trim();
        if (!username) return ack && ack({ ok: false, error: 'Tên không hợp lệ' });

        // Lưu vào Map
        socketToUser.set(socket.id, username);
        onlineUsers.set(username, socket.id);

        // Lưu/Cập nhật User trong DB
        let user = await User.findOne({ username });
        if (!user) {
          user = await User.create({ username, socketId: socket.id, rooms: [] });
        } else {
          user.socketId = socket.id;
          await user.save();
        }

        // Vào phòng mặc định
        const defaultRoom = 'general';
        await ensureRoom(defaultRoom);
        socket.join(defaultRoom);

        // Update DB user room
        user.rooms = Array.from(new Set([...(user.rooms || []), defaultRoom]));
        await user.save();

        // Thông báo trong phòng general
        socket.to(defaultRoom).emit('system', `${username} đã vào phòng ${defaultRoom}`);

        // Gửi danh sách online realtime
        io.emit('users_online', Array.from(onlineUsers.keys()));

        const rooms = [...new Set([defaultRoom])];

        ack && ack({
          ok: true,
          rooms,
          usersOnline: Array.from(onlineUsers.keys())
        });
      } catch (e) {
        console.error(e);
        ack && ack({ ok: false, error: 'Lỗi set_username' });
      }
    });

    // --- 2. THAM GIA PHÒNG ---
    socket.on('join_room', async (room, ack) => {
      try {
        room = (room || '').trim();
        const username = socketToUser.get(socket.id);
        if (!username || !room) return ack && ack({ ok: false });

        await ensureRoom(room);
        socket.join(room);

        socket.to(room).emit('system', `${username} đã tham gia phòng ${room}`);

        // Lấy lịch sử tin nhắn
        const last = await Message.find({ room, isPrivate: false })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean();

        ack && ack({ ok: true, history: last.reverse() });
      } catch (e) {
        console.error(e);
        ack && ack({ ok: false });
      }
    });

    // --- 3. RỜI PHÒNG ---
    socket.on('leave_room', async (room) => {
      const username = socketToUser.get(socket.id);
      try {
        if (!room) return;
        socket.leave(room);
        socket.to(room).emit('system', `${username} đã rời phòng ${room}`);
        await clearRoomIfEmpty(room);
      } catch (e) {
        console.error(e);
      }
    });

    // --- 4. ĐANG GÕ... ---
    socket.on('typing', ({ room, isTyping }) => {
      const username = socketToUser.get(socket.id);
      if (!username || !room) return;

      socket.to(room).emit('typing', {
        room,
        username,
        isTyping: !!isTyping
      });
    });

    // --- 5. CHAT MESSAGES ---
    socket.on('chat_message', async ({ room, content }, ack) => {
      const username = socketToUser.get(socket.id);
      if (!username || !room || !content) return;

      const msg = await Message.create({
        content,
        sender: username,
        room,
        isPrivate: false
      });

      io.to(room).emit('chat_message', msg);
      ack && ack({ ok: true });
    });

    // --- 6. TIN NHẮN RIÊNG (DM) ---
    socket.on('private_message', async ({ to, content }, ack) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to || !content) return ack && ack({ ok: false });

      const payload = await Message.create({
        content,
        sender: from,
        to,
        isPrivate: true
      });

      const toSocket = onlineUsers.get(to);
      if (toSocket) io.to(toSocket).emit('private_message', payload);

      socket.emit('private_message', payload);
      ack && ack({ ok: true });
    });

    // --- 7. ĐÁNH DẤU ĐÃ ĐỌC ---
    socket.on('message_read', async ({ messageId }) => {
      const username = socketToUser.get(socket.id);
      if (!username || !messageId) return;

      try {
        const msg = await Message.findOneAndUpdate(
          { _id: messageId, readBy: { $ne: username } },
          { $addToSet: { readBy: username } },
          { new: true }
        ).lean();

        if (!msg) return;

        const payload = {
          messageId: msg._id,
          readBy: msg.readBy
        };

        if (!msg.isPrivate && msg.room) {
          io.to(msg.room).emit('message_read', payload);
        } else if (msg.isPrivate) {
          const toSocket = onlineUsers.get(msg.to);
          const fromSocket = onlineUsers.get(msg.sender);
          if (toSocket) io.to(toSocket).emit('message_read', payload);
          if (fromSocket) io.to(fromSocket).emit('message_read', payload);
        }
      } catch (e) {
        console.error('message_read error:', e);
      }
    });

    // --- 8. NGẮT KẾT NỐI (DISCONNECT) ---
    socket.on('disconnect', async (reason) => {
      const username = socketToUser.get(socket.id);
      console.log('❌ Client disconnected', socket.id, 'reason:', reason, 'user:', username);

      const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
      for (const r of rooms) {
        try {
          await clearRoomIfEmpty(r);
        } catch (e) { console.error(e); }
      }

      socketToUser.delete(socket.id);

      if (username) {
        onlineUsers.delete(username);

        io.emit('users_online', Array.from(onlineUsers.keys()));
        io.emit('system', `${username} đã thoát`);

        const u = await User.findOne({ username });
        if (u) {
          u.socketId = '';
          u.lastActive = new Date();
          await u.save();
        }
      }
    });

    // --- 9. LẤY USER ONLINE (tùy chọn) ---
    socket.on('get_online_users', () => {
      socket.emit('users_online', Array.from(onlineUsers.keys()));
    });

    socket.on('get_users_online', (ack) => {
      ack && ack({ users: Array.from(onlineUsers.keys()) });
    });

        // --- 10. NHẬN FILE MESSAGE TỪ CLIENT SOCKET ---
    socket.on('file_message', async ({ room, filename, url, size }, ack) => {
      const username = socketToUser.get(socket.id);
      if (!username || !room) return ack && ack({ ok: false });
      
      // Lưu DB
      const msg = await Message.create({
        content: `📎 ${filename}`,
        sender: username,
        room,
        isPrivate: false,
        metadata: { url, size, type: 'file' }
      });

      io.to(room).emit('file_message', msg);
      ack && ack({ ok: true });
    });

    // --- 11. WEBRTC SIGNALING: CALL 1–1 (VOICE / VIDEO) ---
    // Gọi đi
    socket.on('call_user', ({ to, offer, isVideo }) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to || !offer) return;

      const targetSocket = onlineUsers.get(to);
      if (!targetSocket) return;

      io.to(targetSocket).emit('incoming_call', {
        from,
        offer,
        isVideo: !!isVideo
      });
    });

    // Người nhận trả lời
    socket.on('answer_call', ({ to, answer }) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to || !answer) return;

      const targetSocket = onlineUsers.get(to);
      if (!targetSocket) return;

      io.to(targetSocket).emit('call_answered', {
        from,
        answer
      });
    });

    // Trao đổi ICE candidate
    socket.on('ice_candidate', ({ to, candidate }) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to || !candidate) return;

      const targetSocket = onlineUsers.get(to);
      if (!targetSocket) return;

      io.to(targetSocket).emit('ice_candidate', {
        from,
        candidate
      });
    });

    // Kết thúc cuộc gọi
    socket.on('end_call', ({ to }) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to) return;

      const targetSocket = onlineUsers.get(to);
      if (!targetSocket) return;

      io.to(targetSocket).emit('call_ended', { from });
    });

    // Người nhận từ chối cuộc gọi
    socket.on('reject_call', ({ to, reason }) => {
      const from = socketToUser.get(socket.id);
      if (!from || !to) return;

      const targetSocket = onlineUsers.get(to);
      if (!targetSocket) return;

      io.to(targetSocket).emit('call_rejected', {
        from,
        reason: reason || 'rejected'
      });
    });
  }); // <--- hết io.on('connection', (socket) => { ... })
}      // <--- hết export function createSocket(io)
