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
provider.setCustomParameters({
  prompt: 'select_account'
});
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
  isUnauthorizedDomain?: boolean;
  domain?: string;

  constructor(message: string, code?: string, domain?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.domain = domain;
    this.isPopupBlocked = code === 'auth/popup-blocked';
    this.isUnauthorizedDomain = code === 'auth/unauthorized-domain';
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

// Initialize auth state listener with onAuthReady callback to prevent flickering UI
export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void,
  onAuthReady?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    try {
      if (user) {
        const token = cachedAccessToken || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('google_sheets_access_token') : null);
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(user, token);
      } else {
        cachedAccessToken = null;
        try {
          sessionStorage.removeItem('google_sheets_access_token');
        } catch {}
        if (onAuthFailure) onAuthFailure();
      }
    } finally {
      if (onAuthReady) onAuthReady();
    }
  });
};

// Sign in with Google Popup with comprehensive error mapping and diagnostics
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new AuthError('Failed to obtain Google OAuth access token. Please try signing in again.', 'auth/no-access-token');
    }

    cachedAccessToken = credential.accessToken;
    try {
      sessionStorage.setItem('google_sheets_access_token', credential.accessToken);
    } catch {}

    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign-In caught error:', error);

    // 1. auth/unauthorized-domain Handling
    if (error?.code === 'auth/unauthorized-domain') {
      const currentHostname = typeof window !== 'undefined' ? window.location.hostname : 'current domain';
      const projectId = auth.app.options.projectId || 'integral-ascent-xdtd0';
      const consoleDiagnostic = 
        `\n=========================================================\n` +
        `[FIREBASE AUTH DIAGNOSTIC: UNAUTHORIZED DOMAIN DETECTED]\n` +
        `Domain: "${currentHostname}" is NOT listed in Authorized Domains for Firebase Project "${projectId}".\n\n` +
        `HOW TO FIX THIS IN FIREBASE CONSOLE:\n` +
        `1. Open Firebase Console:\n` +
        `   https://console.firebase.google.com/u/0/project/${projectId}/authentication/settings\n` +
        `2. Go to: Authentication -> Settings -> Authorized domains\n` +
        `3. Click "Add domain"\n` +
        `4. Type exact hostname: ${currentHostname}\n` +
        `5. Click "Save"\n\n` +
        `Recommended Authorized Domains to register:\n` +
        ` - localhost\n` +
        ` - 127.0.0.1\n` +
        ` - ${currentHostname}\n` +
        `=========================================================\n`;
      console.error(consoleDiagnostic);

      const userMessage = `Domain "${currentHostname}" is not authorized in your Firebase Authentication configuration. Please add "${currentHostname}" to Firebase Console -> Authentication -> Settings -> Authorized domains.`;
      throw new AuthError(userMessage, error.code, currentHostname);
    }

    // 2. auth/popup-blocked Handling
    if (error?.code === 'auth/popup-blocked') {
      const inIframe = isEmbeddedInIframe();
      const userMessage = inIframe
        ? 'The sign-in popup was blocked by your browser because the dashboard is embedded in an iframe preview. Click "Open in New Tab" to authenticate directly, or allow popups for this site.'
        : 'The sign-in popup was blocked by your browser. Please allow popups for this site in your browser settings and try again.';
      throw new AuthError(userMessage, error.code);
    }

    // 3. auth/popup-closed-by-user Handling
    if (error?.code === 'auth/popup-closed-by-user') {
      throw new AuthError('Sign-in popup was closed before completing authentication. Please click "Continue with Google" to try again.', error.code);
    }

    // 4. auth/cancelled-popup-request Handling
    if (error?.code === 'auth/cancelled-popup-request') {
      throw new AuthError('A sign-in attempt is already in progress. Please wait a moment and try again.', error.code);
    }

    // 5. auth/network-request-failed Handling
    if (error?.code === 'auth/network-request-failed') {
      throw new AuthError('Network request failed during Google sign-in. Please check your internet connection and try again.', error.code);
    }

    // 6. auth/account-exists-with-different-credential Handling
    if (error?.code === 'auth/account-exists-with-different-credential') {
      throw new AuthError('An account already exists with the same email address using a different sign-in provider.', error.code);
    }

    // 7. auth/operation-not-allowed Handling
    if (error?.code === 'auth/operation-not-allowed') {
      const userMessage = 'Google Sign-In is disabled in Firebase Authentication. Enable it in Firebase Console -> Authentication -> Sign-in method.';
      throw new AuthError(userMessage, error.code);
    }

    // 8. auth/invalid-api-key Handling
    if (error?.code === 'auth/invalid-api-key') {
      throw new AuthError('Invalid Firebase API key in configuration. Please verify firebase-applet-config.json settings.', error.code);
    }

    // 9. Generic / Fallback error
    if (error instanceof AuthError) throw error;
    const cleanMessage = error?.message ? String(error.message).replace(/^Firebase:\s*/, '').replace(/\(auth\/[^)]+\)\.?/, '').trim() : 'Failed to complete Google Sign-In.';
    throw new AuthError(cleanMessage || 'Failed to complete Google Sign-In.', error?.code);
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
