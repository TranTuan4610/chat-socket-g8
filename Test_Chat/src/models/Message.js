import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
  content: { type: String, required: true },
  sender: { type: String, required: true }, // username
  room: { type: String },                   // nếu public
  to: { type: String },                     // nếu private
  isPrivate: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },

  // ⭐ danh sách username đã đọc tin nhắn này
  readBy: { type: [String], default: [] }
});

MessageSchema.index({ room: 1, createdAt: -1 });
MessageSchema.index({ sender: 1, to: 1, createdAt: -1 });

export const Message = mongoose.model('Message', MessageSchema);
