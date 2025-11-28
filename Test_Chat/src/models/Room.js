import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true }
});

export const Room = mongoose.model('Room', RoomSchema);
