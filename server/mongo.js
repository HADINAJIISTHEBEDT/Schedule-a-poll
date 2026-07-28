const mongoose = require('mongoose');

let connecting = null;

function getMongoUri() {
  return String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
}

function isMongoConfigured() {
  return Boolean(getMongoUri());
}

async function connectMongo() {
  if (!isMongoConfigured()) return null;
  if (mongoose.connection.readyState === 1) return mongoose;

  if (!connecting) {
    connecting = mongoose
      .connect(getMongoUri(), {
        serverSelectionTimeoutMS: 15000,
      })
      .then(() => {
        console.log('MongoDB connected for WhatsApp session + contacts');
        return mongoose;
      })
      .catch((err) => {
        connecting = null;
        console.error('MongoDB connect failed:', err.message);
        throw err;
      });
  }

  return connecting;
}

function getMongoose() {
  return mongoose.connection.readyState === 1 ? mongoose : null;
}

module.exports = {
  getMongoUri,
  isMongoConfigured,
  connectMongo,
  getMongoose,
  mongoose,
};
