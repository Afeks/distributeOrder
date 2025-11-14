/**
 * Firestore Trigger Function
 * Wird automatisch ausgelöst, wenn eine neue Hauptbestellung (Purchase) erstellt wird
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { distributeOrderWithoutPurchase } from '../../shared/distribute-order';
import {
  DistributionMode,
  Item,
  ServingPoint,
} from '../../shared/types';

const COLLECTION_EVENTS = 'PosEvents';
const COLLECTION_ORDERS = 'Orders';
const COLLECTION_ITEMS = 'Items';
const COLLECTION_SERVING_POINTS = 'Serving-Points';

/**
 * Läd ein ServingPoint aus Firestore
 */
async function getServingPointById(
  eventId: string,
  servingPointId: string
): Promise<ServingPoint | null> {
  try {
    const servingPointDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_SERVING_POINTS)
      .doc(servingPointId)
      .get();

    if (!servingPointDoc.exists) {
      return null;
    }

    const data = servingPointDoc.data()!;
    return {
      id: servingPointDoc.id,
      name: data.name || '',
      location: data.location || '',
      areaName: data.areaName,
      capacity: data.capacity || 0,
    };
  } catch (error) {
    console.error('Error loading serving point:', error);
    return null;
  }
}

/**
 * Läd vollständige Item-Daten aus der globalen Items-Collection
 */
async function getItemDetails(
  eventId: string,
  itemId: string
): Promise<Item | null> {
  try {
    const itemDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_ITEMS)
      .doc(itemId)
      .get();

    if (!itemDoc.exists) {
      return null;
    }

    const data = itemDoc.data()!;
    return {
      id: itemDoc.id,
      name: data.name,
      price: data.price,
      count: data.count,
      category: data.category,
      categoryName: data.categoryName,
      soldOut: data.soldOut || false,
      isAvailable: data.isAvailable !== false,
      selectedExtras: data.selectedExtras || [],
      excludedIngredients: data.excludedIngredients || [],
    };
  } catch (error) {
    console.error('Error loading item details:', error);
    return null;
  }
}

/**
 * Läd Items aus der Purchase Items Sub-Collection
 * und erweitert sie mit vollständigen Item-Details
 * 
 * Die Purchase Items Sub-Collection speichert jetzt auch selectedExtras und excludedIngredients
 */
async function loadPurchaseItems(
  eventId: string,
  purchaseId: string
): Promise<Item[]> {
  const itemsSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_ORDERS)
    .doc(purchaseId)
    .collection(COLLECTION_ITEMS)
    .get();

  const items: Item[] = [];

  for (const itemDoc of itemsSnapshot.docs) {
    const itemData = itemDoc.data();
    const itemId = itemData.itemId || itemDoc.id;
    const baseSelectedExtras = Array.isArray(itemData.selectedExtras)
      ? itemData.selectedExtras
      : [];
    const baseExcludedIngredients = Array.isArray(itemData.excludedIngredients)
      ? itemData.excludedIngredients
      : [];

    const rawQuantity = itemData.quantity ?? itemData.count;
    const entries = Array.isArray(itemData.entries) ? itemData.entries : [];

    let quantity = 0;
    if (rawQuantity !== undefined && rawQuantity !== null) {
      const numericValue = Number(rawQuantity);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        quantity = Math.floor(numericValue);
      }
    }

    if (quantity <= 0 && entries.length > 0) {
      quantity = entries.reduce((sum: number, entry: any) => {
        const value = Number(entry?.quantity ?? 0);
        if (!Number.isFinite(value) || value <= 0) {
          return sum;
        }
        return sum + Math.floor(value);
      }, 0);
    }

    if (quantity <= 0) {
      quantity = 1;
    }

    const pushItemInstances = (
      quantityToCreate: number,
      selectedExtras: string[],
      excludedIngredients: string[],
      itemDetailsOverride?: Item
    ) => {
      const extras = selectedExtras.slice();
      const excluded = excludedIngredients.slice();

      if (itemDetailsOverride) {
        for (let i = 0; i < quantityToCreate; i++) {
          items.push({
            ...itemDetailsOverride,
            id: itemId,
            count: 1,
            selectedExtras: extras,
            excludedIngredients: excluded,
          });
        }
      } else {
        for (let i = 0; i < quantityToCreate; i++) {
          items.push({
            id: itemId,
            name: itemData.name || 'Unknown Item',
            price: itemData.price || 0,
            count: 1,
            category: itemData.category,
            categoryName: itemData.categoryName,
            selectedExtras: extras,
            excludedIngredients: excluded,
          });
        }
      }
    };

    const itemDetails = await getItemDetails(eventId, itemId);

    if (!itemDetails) {
      console.warn(`Item details not found for itemId: ${itemId}`);
    }

    let generatedFromEntries = 0;
    if (entries.length > 0) {
      for (const entry of entries) {
        const entryQuantityRaw = entry?.quantity ?? 1;
        const entryQuantityValue = Number(entryQuantityRaw);
        const entryQuantity = Number.isFinite(entryQuantityValue) && entryQuantityValue > 0
          ? Math.floor(entryQuantityValue)
          : 0;

        if (entryQuantity <= 0) {
          continue;
        }

        const entrySelectedExtras = Array.isArray(entry?.selectedExtras)
          ? entry.selectedExtras
          : baseSelectedExtras;
        const entryExcludedIngredients = Array.isArray(entry?.excludedIngredients)
          ? entry.excludedIngredients
          : baseExcludedIngredients;

        pushItemInstances(
          entryQuantity,
          entrySelectedExtras,
          entryExcludedIngredients,
          itemDetails || undefined
        );

        generatedFromEntries += entryQuantity;
      }
    }

    const remainingQuantity = Math.max(quantity - generatedFromEntries, 0);

    if (remainingQuantity > 0) {
      pushItemInstances(
        remainingQuantity,
        baseSelectedExtras,
        baseExcludedIngredients,
        itemDetails || undefined
      );
    }
  }

  return items;
}

/**
 * Läd den DistributionMode aus dem Event
 */
async function getDistributionMode(eventId: string): Promise<DistributionMode> {
  try {
    const eventDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .get();

    if (!eventDoc.exists) {
      return DistributionMode.BALANCED; // Default
    }

    const data = eventDoc.data()!;
    const mode = data.distributionMode;

    if (mode === 'grouped') {
      return DistributionMode.GROUPED;
    }

    return DistributionMode.BALANCED; // Default
  } catch (error) {
    console.error('Error loading distribution mode:', error);
    return DistributionMode.BALANCED; // Default
  }
}

/**
 * Firestore Trigger: Wird ausgelöst, wenn eine Purchase erstellt oder aktualisiert wird
 * und erstmals den Status "isPaid = true" erhält.
 * 
 * Pfad: Events/{eventId}/Orders/{purchaseId}
 */
export const onPurchaseCreated = functions
  .region('europe-west1')
  .firestore.document(`${COLLECTION_EVENTS}/{eventId}/${COLLECTION_ORDERS}/{purchaseId}`)
  .onWrite(async (change, context) => {
    const beforeData = change.before.exists ? change.before.data() : undefined;
    const purchaseData = change.after.exists ? change.after.data() : undefined;
    const eventId = context.params.eventId;
    const purchaseId = context.params.purchaseId;

    if (!purchaseData) {
      console.log(`Purchase ${purchaseId} for event ${eventId} was deleted. Skipping.`);
      return null;
    }

    const wasPaidBefore = beforeData?.isPaid === true;
    const isPaidNow = purchaseData.isPaid === true;

    if (!isPaidNow) {
      console.log(`Purchase ${purchaseId} for event ${eventId} is not paid yet. Waiting.`);
      return null;
    }

    if (wasPaidBefore) {
      console.log(`Purchase ${purchaseId} for event ${eventId} was already processed when paid. Skipping.`);
      return null;
    }

    console.log(`Purchase ${purchaseId} for event ${eventId} marked as paid. Starting distribution.`);

    try {
      // Prüfe ob bereits verteilt wurde (verhindert Re-Triggering)
      if (purchaseData.distributed) {
        console.log(`Purchase ${purchaseId} already distributed, skipping`);
        return null;
      }

      // Lade ServingPoint
      const servingPointId = purchaseData.servingPointId;
      if (!servingPointId) {
        console.error(`No servingPointId found for purchase ${purchaseId}`);
        return null;
      }

      const servingPoint = await getServingPointById(eventId, servingPointId);
      if (!servingPoint) {
        console.error(`ServingPoint ${servingPointId} not found for event ${eventId}`);
        return null;
      }

      // Lade Items aus der Purchase Items Sub-Collection
      const items = await loadPurchaseItems(eventId, purchaseId);
      console.log(`Loaded ${items.length} items from purchase ${purchaseId}`);
      if (items.length === 0) {
        console.error(`No items found for purchase ${purchaseId}`);
        return null;
      }
      console.log(`Items to distribute: ${items.map(i => i.id).join(', ')}`);

      // Lade DistributionMode aus dem Event
      const distributionMode = await getDistributionMode(eventId);
      console.log(`DistributionMode: ${distributionMode}`);

      // Rufe distributeOrderWithoutPurchase auf (Purchase existiert bereits)
      console.log(`Starting distribution...`);
      const result = await distributeOrderWithoutPurchase(
        purchaseId,
        eventId,
        items,
        servingPoint,
        distributionMode,
        purchaseData.note
      );

      console.log(`Distribution result - success: ${result.success}, distributedPurchases: ${result.distributedPurchases.length}, error: ${result.error || 'none'}`);

      if (result.success) {
        // Markiere Purchase als verteilt
        await change.after.ref.update({
          distributed: true,
          distributedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          `Successfully distributed purchase ${purchaseId} to ${result.distributedPurchases.length} points of sale`
        );
      } else {
        console.error(
          `Failed to distribute purchase ${purchaseId}: ${result.error}`
        );
      }

      return result;
    } catch (error: any) {
      console.error(`Error processing purchase ${purchaseId}:`, error);
      // Optional: Markiere als fehlgeschlagen
      try {
        await change.after.ref.update({
          distributionError: error.message,
          distributionFailed: true,
        });
      } catch (updateError) {
        console.error('Failed to update purchase with error:', updateError);
      }
      throw error;
    }
  });

