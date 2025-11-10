async function loadOrderItemIds(
  eventId: string,
  orderId: string
): Promise<string[]> {
  const itemsSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_ORDERS)
    .doc(orderId)
    .collection('Items')
    .get();

  const itemIds: string[] = [];

  itemsSnapshot.forEach((doc) => {
    const data = doc.data();
    const id = data.itemId || data.id || doc.id;
    if (id) {
      itemIds.push(id);
    }
  });

  return itemIds;
}
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { createNotification } from '../../shared/notifications';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_ORDERS = 'Orders';

interface OrderData {
  status?: string;
  isPaid?: boolean;
  paymentMethod?: string;
  servingPointId?: string;
  totalPrice?: number;
}

async function getServingPointName(
  eventId: string,
  servingPointId?: string
): Promise<string | undefined> {
  if (!servingPointId) {
    return undefined;
  }

  const doc = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection('Serving-Points')
    .doc(servingPointId)
    .get();

  if (!doc.exists) {
    return undefined;
  }
  const data = doc.data();
  return data?.name || data?.location || undefined;
}

export const onOrderCreated = functions
  .region('europe-west1')
  .firestore.document(`${COLLECTION_EVENTS}/{eventId}/${COLLECTION_ORDERS}/{orderId}`)
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data() as OrderData | undefined;

    if (!data) {
      return null;
    }

    const status = data.status || snapshot.get('orderStatus');
    const isPaid = data.isPaid === true;
    const paymentMethod = data.paymentMethod || snapshot.get('paymentMethod');

    if (status !== 'pending' || isPaid || paymentMethod !== 'cash') {
      return null;
    }

    const eventId: string = context.params.eventId;
    const orderId: string = context.params.orderId;

    const pointOfService =
      (await getServingPointName(eventId, data.servingPointId)) ||
      snapshot.get('servingPointName') ||
      undefined;

    const price = Number(data.totalPrice ?? snapshot.get('totalPrice'));
    const itemIds = await loadOrderItemIds(eventId, orderId);

    await createNotification(eventId, {
      title: 'Barzahlung erforderlich',
      message: 'Bitte zur Bestellung gehen und kassieren.',
      pointOfService,
      price: Number.isFinite(price) ? price : undefined,
      orderId,
      itemIds,
      paymentMethod: paymentMethod || 'cash',
      severity: 'warning',
      action: 'collect_cash',
      status: 'created',
    });

    functions.logger.info('Created cash payment notification', {
      eventId,
      orderId,
      pointOfService,
    });

    return null;
  });

