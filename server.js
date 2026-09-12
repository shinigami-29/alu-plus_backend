require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth'); 
const serviceAccountPath =
  process.env.RENDER ? '/etc/secrets/serviceAccountKey.json' : './serviceAccountKey.json';
const serviceAccount = require(serviceAccountPath);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const messaging = getMessaging();
const authAdmin = getAuth();

const app = express();
app.use(cors());
app.use(express.json());

app.post('/send-notification', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ADDED: verify the Firebase ID token is real and not expired
  const idToken = authHeader.split('Bearer ')[1];
  try {
    await authAdmin.verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { toUsername, title, body, channelId, type, roomCode, fromName } = req.body;

  if (!toUsername || !title || !body) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const snap = await db
      .collection('users')
      .where('username', '==', toUsername)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = snap.docs[0];
    const fcmToken = userDoc.data()?.fcmToken;

    if (!fcmToken) {
      return res.status(404).json({ error: 'No FCM token for this user' });
    }

    await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data: {
        channelId: channelId || 'default',
        type: type || '',
        roomCode: roomCode || '',
        fromName: fromName || '',
      },
      android: {
        notification: {
          channelId: channelId || 'default',
        },
      },
    });

    console.log(`Notification sent to ${toUsername}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Send notification error:', err);

    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      try {
        const snap = await db
          .collection('users')
          .where('username', '==', toUsername)
          .limit(1)
          .get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({ fcmToken: null });
          console.log(`Cleared invalid token for ${toUsername}`);
        }
      } catch (cleanupErr) {
        console.error('Token cleanup failed:', cleanupErr.message);
      }
    }

    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});