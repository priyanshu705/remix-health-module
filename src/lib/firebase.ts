import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  getDocs, 
  collection, 
  deleteDoc, 
  getDocFromServer,
  onSnapshot,
  query,
  orderBy
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize Firebase App singleton
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// CRITICAL: Initialize Firestore with firestoreDatabaseId from configuration
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Export Auth instance
export const auth = getAuth(app);

// Test connection on boot according to skill guidelines
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Firestore connection: client is currently offline or unreachable.");
    }
    return false;
  }
}

// Standardized Operation Types & Error Handling
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const currentUser = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo: currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// User Profile & Preferences Persistence
export interface UserProfileData {
  id: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  lastSpreadsheetId?: string;
  lastSpreadsheetTitle?: string;
  createdAt: string;
  updatedAt: string;
}

export async function syncUserProfile(user: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}, lastSpreadsheetId?: string, lastSpreadsheetTitle?: string): Promise<void> {
  if (!user.uid) return;
  const userPath = `users/${user.uid}`;
  const now = new Date().toISOString();

  try {
    const userRef = doc(db, 'users', user.uid);
    const existing = await getDoc(userRef);

    if (!existing.exists()) {
      const newProfile: UserProfileData = {
        id: user.uid,
        email: user.email || '',
        displayName: user.displayName || 'Google User',
        photoURL: user.photoURL || '',
        lastSpreadsheetId: lastSpreadsheetId || '',
        lastSpreadsheetTitle: lastSpreadsheetTitle || '',
        createdAt: now,
        updatedAt: now
      };
      await setDoc(userRef, newProfile);
    } else {
      const data = existing.data();
      const updatedProfile: UserProfileData = {
        id: user.uid,
        email: user.email || data.email || '',
        displayName: user.displayName || data.displayName || 'Google User',
        photoURL: user.photoURL || data.photoURL || '',
        lastSpreadsheetId: lastSpreadsheetId !== undefined ? lastSpreadsheetId : (data.lastSpreadsheetId || ''),
        lastSpreadsheetTitle: lastSpreadsheetTitle !== undefined ? lastSpreadsheetTitle : (data.lastSpreadsheetTitle || ''),
        createdAt: data.createdAt || now,
        updatedAt: now
      };
      await setDoc(userRef, updatedProfile);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

// Saved / Pinned Spreadsheets Persistence
export interface SavedSpreadsheetRecord {
  id: string;
  userId: string;
  spreadsheetId: string;
  title: string;
  activeTabName?: string;
  detectedArchetype?: string;
  isFavorite?: boolean;
  lastAccessedAt?: string;
  createdAt: string;
}

export async function saveSpreadsheetToFirestore(
  userId: string,
  spreadsheet: {
    spreadsheetId: string;
    title: string;
    activeTabName?: string;
    detectedArchetype?: string;
    isFavorite?: boolean;
  }
): Promise<void> {
  const docId = spreadsheet.spreadsheetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const path = `users/${userId}/saved_spreadsheets/${docId}`;
  const now = new Date().toISOString();

  try {
    const docRef = doc(db, 'users', userId, 'saved_spreadsheets', docId);
    const existing = await getDoc(docRef);
    const createdAt = existing.exists() ? existing.data().createdAt : now;

    const record: SavedSpreadsheetRecord = {
      id: docId,
      userId,
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.title.slice(0, 256),
      activeTabName: spreadsheet.activeTabName?.slice(0, 128),
      detectedArchetype: spreadsheet.detectedArchetype?.slice(0, 64),
      isFavorite: spreadsheet.isFavorite ?? false,
      lastAccessedAt: now,
      createdAt
    };

    await setDoc(docRef, record);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function getSavedSpreadsheetsFromFirestore(userId: string): Promise<SavedSpreadsheetRecord[]> {
  const path = `users/${userId}/saved_spreadsheets`;
  try {
    const q = collection(db, 'users', userId, 'saved_spreadsheets');
    const snapshot = await getDocs(q);
    const results: SavedSpreadsheetRecord[] = [];
    snapshot.forEach(d => {
      results.push(d.data() as SavedSpreadsheetRecord);
    });
    return results;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function deleteSavedSpreadsheetFromFirestore(userId: string, docId: string): Promise<void> {
  const path = `users/${userId}/saved_spreadsheets/${docId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'saved_spreadsheets', docId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
