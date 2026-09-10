import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User, 
  signOut 
} from 'firebase/auth';
import { auth } from './firebase';
export { auth };

// Google Workspace Scopes
export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

const provider = new GoogleAuthProvider();
SCOPES.forEach(scope => provider.addScope(scope));

// Helper to check if running inside an iframe
export const isEmbeddedInIframe = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
};

export class AuthError extends Error {
  code?: string;
  isPopupBlocked?: boolean;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.isPopupBlocked = code === 'auth/popup-blocked';
  }
}

let isSigningIn = false;
let cachedAccessToken: string | null = (() => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('google_sheets_access_token') : null;
  } catch {
    return null;
  }
})();

// Initialize auth state listener
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = cachedAccessToken || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('google_sheets_access_token') : null);
      if (token) {
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(user, token);
      } else if (!isSigningIn) {
        // When user is restored from session without cached token,
        // user can click 'Connect with Google'
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      try {
        sessionStorage.removeItem('google_sheets_access_token');
      } catch {}
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Sign in with Google Popup
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain access token with Google Sheets permissions');
    }

    cachedAccessToken = credential.accessToken;
    try {
      sessionStorage.setItem('google_sheets_access_token', credential.accessToken);
    } catch {}

    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    if (error?.code === 'auth/popup-blocked') {
      const inIframe = isEmbeddedInIframe();
      const message = inIframe
        ? 'The sign-in popup was blocked by your browser because the dashboard is embedded in an iframe preview. Click "Open in New Tab" to authenticate directly, or enable popups for this site.'
        : 'The sign-in popup was blocked by your browser. Please allow popups for this site in your browser settings and try again.';
      throw new AuthError(message, error.code);
    }
    if (error?.code === 'auth/popup-closed-by-user') {
      throw new AuthError('Sign-in was cancelled before completion. Please try again.', error.code);
    }
    if (error?.code === 'auth/cancelled-popup-request') {
      throw new AuthError('Another sign-in request is already in progress.', error.code);
    }
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('google_sheets_access_token') : null);
};

export const setAccessToken = (token: string | null) => {
  cachedAccessToken = token;
  try {
    if (token) {
      sessionStorage.setItem('google_sheets_access_token', token);
    } else {
      sessionStorage.removeItem('google_sheets_access_token');
    }
  } catch {}
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  try {
    sessionStorage.removeItem('google_sheets_access_token');
  } catch {}
};
