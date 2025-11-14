import * as admin from 'firebase-admin';
import { NotificationPayload } from './types';

const COLLECTION_EVENTS = 'PosEvents';
const COLLECTION_NOTIFICATIONS = 'Notifications';

export async function createNotification(
  eventId: string,
  payload: NotificationPayload
): Promise<string> {
  if (!eventId) {
    throw new Error('Event ID is required to create a notification');
  }
  if (!payload.title || !payload.message) {
    throw new Error('Notification must contain at least title and message');
  }

  const notificationsRef = admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_NOTIFICATIONS);

  const baseData = {
    title: payload.title,
    message: payload.message,
    pointOfService: payload.pointOfService || null,
    price: payload.price ?? null,
    itemIds: Array.isArray(payload.itemIds) ? payload.itemIds : [],
    orderId: payload.orderId || null,
    paymentMethod: payload.paymentMethod || null,
    severity: payload.severity || 'info',
    action: payload.action || null,
    status: payload.status || 'created',
  };

  if (payload.orderId) {
    const existingSnapshot = await notificationsRef
      .where('orderId', '==', payload.orderId)
      .where('action', '==', baseData.action)
      .where('status', 'in', ['created', 'in_progress'])
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      const existingRef = existingSnapshot.docs[0].ref;
      await existingRef.update({
        ...baseData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return existingRef.id;
    }
  }

  const docRef = await notificationsRef.add({
    ...baseData,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return docRef.id;
}

