import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  socketId: { type: String },
  rooms: { type: [String], default: [] },
  lastActive: { type: Date, default: Date.now }
});

export const User = mongoose.model('User', UserSchema);
