# Socket Chat (Express + Socket.IO + MongoDB)

## Yêu cầu môi trường
- Node.js 18+
- MongoDB đang chạy (local hoặc Atlas)

Mở trình duyệt: 

[https://chat-socket-g8.vercel.app/login.html](https://chat-socket-g8.vercel.app/)


## Tính năng đã triển khai
- Đặt tên người dùng khi vào
- Thông báo người dùng vào/ra phòng
- Nhiều phòng chat (join/leave room)
- Nhắn tin phòng (public)
- Nhắn tin riêng 1-1 (private)
- Lưu lịch sử tin nhắn (phòng & cá nhân) vào MongoDB
- API lấy lịch sử phòng và lịch sử 1-1
- Danh sách người dùng đang online

## Cấu trúc thư mục
```
src/
  db.js
  server.js
  socket.js
  models/
    User.js
    Room.js
    Message.js
public/
  index.html
  styles.css
  client.js
```

## Ghi chú
- Mặc định tạo phòng `general`. Bạn có thể tạo phòng mới ở client.
- Lịch sử phòng khi vào sẽ tải 50 tin gần nhất.
- Lịch sử DM tải ở tab DM khi chọn 1 người dùng.
