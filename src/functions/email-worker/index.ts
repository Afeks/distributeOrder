import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import nodemailer, { Transporter } from 'nodemailer';

const EMAIL_QUEUE_COLLECTION = 'emailQueue';
const ASSOCIATIONS_COLLECTION = 'associations';
const MAX_ATTEMPTS = 5;

type EmailStatus = 'pending' | 'processing' | 'sent' | 'error' | 'failed';

interface EmailQueueDocument {
  associationId?: string;
  to?: string;
  subject?: string;
  body?: string;
  replyTo?: string;
  status?: EmailStatus;
  attempts?: number;
  createdAt?: FirebaseFirestore.Timestamp;
  lockedAt?: FirebaseFirestore.Timestamp;
  sentAt?: FirebaseFirestore.Timestamp;
  lastError?: string;
}

interface AssociationEmailSettings {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  useTLS: boolean;
  senderName: string;
  senderEmail: string;
  replyTo?: string | null;
}

interface AssociationDocument {
  name?: string;
  emailSettings?: Partial<AssociationEmailSettings>;
}

interface SendEmailParams {
  transporter: Transporter;
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string | null;
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const getAssociationIdFromDocRef = (
  docRef: FirebaseFirestore.DocumentReference
): string | undefined => docRef.parent?.parent?.id;

const loadAssociationEmailSettings = async (
  associationId?: string
): Promise<AssociationEmailSettings> => {
  if (!associationId) {
    throw new Error('Association ID fehlt.');
  }

  const snap = await db
    .collection(ASSOCIATIONS_COLLECTION)
    .doc(associationId)
    .get();

  if (!snap.exists) {
    throw new Error(`Association ${associationId} nicht gefunden.`);
  }

  const data = snap.data() as AssociationDocument | undefined;
  const settings = data?.emailSettings ?? {};

  const required: Array<keyof AssociationEmailSettings> = [
    'smtpHost',
    'smtpPort',
    'smtpUser',
    'smtpPassword',
    'senderEmail',
  ];

  for (const key of required) {
    if (!settings[key]) {
      throw new Error(
        `SMTP-Einstellung "${key}" fehlt für Association ${associationId}.`
      );
    }
  }

  return {
    smtpHost: String(settings.smtpHost),
    smtpPort: Number(settings.smtpPort) || 587,
    smtpUser: String(settings.smtpUser),
    smtpPassword: String(settings.smtpPassword),
    useTLS: settings.useTLS ?? true,
    senderName: settings.senderName || data?.name || 'Ticketing',
    senderEmail: String(settings.senderEmail),
    replyTo: settings.replyTo ?? null,
  };
};

const buildTransporter = (config: AssociationEmailSettings): Transporter => {
  const isSecure = config.smtpPort === 465 && config.useTLS !== false;
  const transportOptions: nodemailer.TransportOptions & {
    requireTLS?: boolean;
  } = {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: isSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
  } as nodemailer.TransportOptions;

  if (config.useTLS && !isSecure) {
    transportOptions.requireTLS = true;
  }

  return nodemailer.createTransport(transportOptions);
};

const sendEmail = async ({
  transporter,
  fromName,
  fromEmail,
  to,
  subject,
  body,
  replyTo,
}: SendEmailParams): Promise<void> => {
  const trimmedBody = body.trim();
  const mailOptions: nodemailer.SendMailOptions = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to,
    subject,
    text: trimmedBody,
  };

  const containsHtml = /<\/?[a-z][\s\S]*>/i.test(trimmedBody);
  if (containsHtml) {
    mailOptions.html = trimmedBody;
  }

  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }

  await transporter.sendMail(mailOptions);
};

const markAsFailed = async (
  docRef: FirebaseFirestore.DocumentReference,
  error: unknown,
  attempts: number
): Promise<void> => {
  const status: EmailStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'error';
  const errorMessage =
    error instanceof Error ? error.message : String(error ?? 'Unbekannter Fehler');

  await docRef.update({
    status,
    lastError: errorMessage,
    lockedAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
};

const handleEmailDocument = async (
  docRef: FirebaseFirestore.DocumentReference,
  providedAssociationId?: string
): Promise<void> => {
  let emailData: EmailQueueDocument | undefined;
  let currentAttempts = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error('Dokument existiert nicht mehr.');
    }

    const data = snap.data() as EmailQueueDocument;
    const status: EmailStatus = data.status ?? 'pending';

    if (status === 'sent') {
      throw new Error('Bereits versendet.');
    }

    if (status === 'processing') {
      throw new Error('Wird bereits verarbeitet.');
    }

    emailData = data;
    currentAttempts = (data.attempts ?? 0) + 1;

    tx.update(docRef, {
      status: 'processing',
      attempts: FieldValue.increment(1),
      lockedAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  if (!emailData) {
    return;
  }

  try {
    const associationId =
      providedAssociationId ??
      emailData.associationId ??
      getAssociationIdFromDocRef(docRef);

    if (!associationId) {
      throw new Error('Association ID konnte nicht ermittelt werden.');
    }

    const associationConfig = await loadAssociationEmailSettings(associationId);
    const transporter = buildTransporter(associationConfig);

    const to = emailData.to?.trim();
    const subject = emailData.subject?.trim();
    const body = emailData.body ?? '';

    if (!to || !subject || !body.trim()) {
      throw new Error('E-Mail-Daten unvollständig (to/subject/body).');
    }

    await sendEmail({
      transporter,
      fromName: associationConfig.senderName,
      fromEmail: associationConfig.senderEmail,
      to,
      subject,
      body,
      replyTo: emailData.replyTo ?? associationConfig.replyTo,
    });

    await docRef.update({
      status: 'sent',
      sentAt: FieldValue.serverTimestamp(),
      lockedAt: FieldValue.delete(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    functions.logger.info('E-Mail erfolgreich versendet', {
      docId: docRef.id,
      to,
    });
  } catch (error) {
    functions.logger.error('Fehler beim E-Mail-Versand', {
      docId: docRef.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await markAsFailed(docRef, error, currentAttempts);
  }
};

export const onEmailQueued = functions
  .region('europe-west1')
  .firestore.document(
    `${ASSOCIATIONS_COLLECTION}/{associationId}/${EMAIL_QUEUE_COLLECTION}/{emailId}`
  )
  .onCreate(async (snap, context) => {
    try {
      const { associationId } = context.params as { associationId: string };
      await handleEmailDocument(snap.ref, associationId);
    } catch (error) {
      functions.logger.warn('E-Mail konnte nicht sofort verarbeitet werden', {
        docId: snap.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const processEmailQueue = functions
  .region('europe-west1')
  .pubsub.schedule('every 5 minutes')
  .timeZone('Europe/Berlin')
  .onRun(async () => {
    const batch = await db
      .collectionGroup(EMAIL_QUEUE_COLLECTION)
      .where('status', 'in', ['pending', 'error'])
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();

    if (batch.empty) {
      functions.logger.info('Keine offenen E-Mail-Aufträge gefunden.');
      return null;
    }

    for (const doc of batch.docs) {
      try {
        await handleEmailDocument(doc.ref);
      } catch (error) {
        functions.logger.warn('Batch-Versand fehlgeschlagen', {
          docId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  });


