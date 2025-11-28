import mongoose from 'mongoose';

export async function connectDB(url) {
  const mongoUrl = url || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/socketchat';
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUrl, { dbName: 'socketchat' });
  console.log('✅ Connected to MongoDB:', mongoUrl);
}
