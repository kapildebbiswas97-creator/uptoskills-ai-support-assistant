import { useState, type FormEvent } from 'react';
import {
  Mail,
  Lock,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  ArrowLeft,
  Eye,
  EyeOff,
  ShieldCheck,
} from 'lucide-react';
import { BrandMark } from './BrandMark';
import {
  isSupabaseConfigured,
  isGoogleOAuthConfigured,
  signInWithEmail,
  signUpWithEmail,
  signInWithGoogle,
  resendSignUpVerification,
  sendPasswordResetEmail,
  updatePassword,
} from '../utils/supabaseClient';

export type AuthMode = 'signIn' | 'signUp' | 'forgotPassword' | 'resetPassword' | 'emailVerification';

interface AuthScreenProps {
  initialMode?: AuthMode;
  onSuccess?: () => void | boolean | Promise<void | boolean>;
  defaultEmail?: string;
}

export function AuthScreen({
  initialMode = 'signIn',
  onSuccess,
  defaultEmail = '',
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const configured = isSupabaseConfigured();
  const googleConfigured = isGoogleOAuthConfigured();

  const validateEmail = (value: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!configured) {
      setError('Authentication service is not configured. Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!validateEmail(cleanEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      const { data, error: authError } = await signInWithEmail(cleanEmail, password);
      if (authError) {
        if (authError.message.includes('Invalid login credentials')) {
          setError('Incorrect email or password. Please verify your credentials.');
        } else if (authError.message.toLowerCase().includes('email not confirmed')) {
          setMode('emailVerification');
          setError('Your email has not been verified yet. Check your inbox for the confirmation link.');
        } else {
          setError(authError.message);
        }
        return;
      }
      if (data?.session) {
        const verified = await onSuccess?.();
        if (verified === false) setError('Your sign-in succeeded, but secure application access could not be verified. Please retry shortly.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred during sign-in.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!configured) {
      setError('Authentication service is not configured. Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!validateEmail(cleanEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { data, error: authError } = await signUpWithEmail(cleanEmail, password);
      if (authError) {
        setError(authError.message);
        return;
      }
      if (data?.user && !data.session) {
        // Email confirmation is required
        setMode('emailVerification');
        setSuccessMessage('Account created! Please check your email to verify your account.');
      } else if (data?.session) {
        const verified = await onSuccess?.();
        if (verified === false) setError('Your account was created, but secure application access could not be verified. Please retry shortly.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred during account creation.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    if (!configured) {
      setError('Authentication service is not configured. Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }
    if (!googleConfigured) {
      setError('Google sign-in is not enabled for this deployment. Use email and password instead.');
      return;
    }
    setGoogleLoading(true);
    try {
      const { error: authError } = await signInWithGoogle();
      if (authError) {
        setError(authError.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in could not be initiated.');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!configured) {
      setError('Authentication service is not configured.');
      return;
    }

    const cleanEmail = email.trim();
    if (!cleanEmail || !validateEmail(cleanEmail)) {
      setError('Please enter a valid email address to receive password reset instructions.');
      return;
    }

    setLoading(true);
    try {
      const { error: authError } = await sendPasswordResetEmail(cleanEmail);
      if (authError) {
        setError(authError.message);
        return;
      }
      setSuccessMessage('Password reset instructions have been sent to your email address.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset email.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { error: authError } = await updatePassword(password);
      if (authError) {
        setError(authError.message);
        return;
      }
      setSuccessMessage('Your password has been successfully updated! You can now sign in.');
      setPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setMode('signIn');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) return;
    setResendLoading(true);
    setError(null);
    try {
      const { error: authError } = await resendSignUpVerification(email);
      if (authError) setError(authError.message);
      else setSuccessMessage('A fresh verification link has been sent to your inbox.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend verification email.');
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-[#0B1220] p-4 sm:p-6 lg:p-8">
      <div className="w-full max-w-md space-y-6">
        {/* Header & Brand */}
        <div className="flex flex-col items-center text-center">
          <BrandMark className="h-12 w-28 shadow-lg" />
          <h1 className="mt-4 font-display text-2xl font-bold tracking-tight text-[#F8FAFC]">
            UpToSkills AI Support
          </h1>
          <p className="mt-1 text-sm text-[#94A3B8]">
            {mode === 'signIn' && 'Sign in to access verified support, guidance, and HR escalation services.'}
            {mode === 'signUp' && 'Create your account to start asking questions and managing requests.'}
            {mode === 'forgotPassword' && 'Enter your email to receive password reset instructions.'}
            {mode === 'resetPassword' && 'Create a new secure password for your account.'}
            {mode === 'emailVerification' && 'Verify your email address to activate your account.'}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#111827]/90 p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
          {/* Alerts */}
          {error && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-950/40 p-3.5 text-sm text-red-300"
            >
              <AlertCircle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" aria-hidden="true" />
              <div className="flex-1 leading-relaxed">{error}</div>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              className="mb-5 flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-950/40 p-3.5 text-sm text-emerald-300"
            >
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" aria-hidden="true" />
              <div className="flex-1 leading-relaxed">{successMessage}</div>
            </div>
          )}

          {!configured && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-950/40 p-3.5 text-xs text-amber-300"
            >
              <ShieldCheck className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" aria-hidden="true" />
              <div className="flex-1 leading-relaxed">
                Supabase configuration is missing (<code className="font-mono text-amber-200">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono text-amber-200">VITE_SUPABASE_PUBLISHABLE_KEY</code>). Complete setup in environment settings.
              </div>
            </div>
          )}

          {/* Form: Sign In */}
          {mode === 'signIn' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label htmlFor="signin-email" className="block text-xs font-medium text-[#CBD5E1]">
                  Email Address
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Mail className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="intern@example.com"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-3 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="signin-password" className="block text-xs font-medium text-[#CBD5E1]">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setSuccessMessage(null);
                      setMode('forgotPassword');
                    }}
                    className="text-xs font-medium text-[#38BDF8] hover:text-[#7DD3FC] transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="signin-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-10 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#64748B] hover:text-[#94A3B8]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#0284C7] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#0369A1] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign In'}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>

              <div className="relative my-4" hidden={!googleConfigured}>
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-white/[0.08]" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-[#111827] px-3 text-[#64748B]">Or continue with</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={googleLoading}
                hidden={!googleConfigured}
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-white/[0.08] bg-[#1E293B] px-4 py-2.5 text-sm font-medium text-[#F8FAFC] shadow-sm transition-colors hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50"
              >
                {googleLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#94A3B8]" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                )}
                Continue with Google
              </button>

              <div className="pt-2 text-center text-xs text-[#94A3B8]">
                Don't have an account?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setSuccessMessage(null);
                    setMode('signUp');
                  }}
                  className="font-semibold text-[#38BDF8] hover:text-[#7DD3FC] transition-colors"
                >
                  Create Account
                </button>
              </div>
            </form>
          )}

          {/* Form: Sign Up */}
          {mode === 'signUp' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <div>
                <label htmlFor="signup-email" className="block text-xs font-medium text-[#CBD5E1]">
                  Email Address
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Mail className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="intern@example.com"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-3 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="signup-password" className="block text-xs font-medium text-[#CBD5E1]">
                  Password (min. 8 characters)
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="signup-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-10 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#64748B] hover:text-[#94A3B8]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="signup-confirm-password" className="block text-xs font-medium text-[#CBD5E1]">
                  Confirm Password
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="signup-confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-3 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#0284C7] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#0369A1] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Account'}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>

              <div className="relative my-4" hidden={!googleConfigured}>
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-white/[0.08]" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-[#111827] px-3 text-[#64748B]">Or continue with</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={googleLoading}
                hidden={!googleConfigured}
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-white/[0.08] bg-[#1E293B] px-4 py-2.5 text-sm font-medium text-[#F8FAFC] shadow-sm transition-colors hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50"
              >
                {googleLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#94A3B8]" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                )}
                Continue with Google
              </button>

              <div className="pt-2 text-center text-xs text-[#94A3B8]">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setSuccessMessage(null);
                    setMode('signIn');
                  }}
                  className="font-semibold text-[#38BDF8] hover:text-[#7DD3FC] transition-colors"
                >
                  Sign In
                </button>
              </div>
            </form>
          )}

          {/* Form: Forgot Password */}
          {mode === 'forgotPassword' && (
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <div>
                <label htmlFor="forgot-email" className="block text-xs font-medium text-[#CBD5E1]">
                  Email Address
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Mail className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="intern@example.com"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-3 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#0284C7] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#0369A1] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send Reset Link'}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setSuccessMessage(null);
                    setMode('signIn');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Sign In
                </button>
              </div>
            </form>
          )}

          {/* Form: Reset Password (after recovery link) */}
          {mode === 'resetPassword' && (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label htmlFor="reset-new-password" className="block text-xs font-medium text-[#CBD5E1]">
                  New Password (min. 8 characters)
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="reset-new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-10 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#64748B] hover:text-[#94A3B8]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="reset-confirm-password" className="block text-xs font-medium text-[#CBD5E1]">
                  Confirm New Password
                </label>
                <div className="relative mt-1.5">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" aria-hidden="true" />
                  </div>
                  <input
                    id="reset-confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border border-white/[0.08] bg-[#1E293B] pl-10 pr-3 py-2.5 text-sm text-[#F8FAFC] placeholder-[#64748B] focus:border-[#38BDF8] focus:outline-none focus:ring-1 focus:ring-[#38BDF8]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#0284C7] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#0369A1] focus:outline-none focus:ring-2 focus:ring-[#38BDF8] focus:ring-offset-2 focus:ring-offset-[#111827] disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update Password'}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>
            </form>
          )}

          {/* Screen: Email Verification Confirmation */}
          {mode === 'emailVerification' && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#0284C7]/10 border border-[#0284C7]/20">
                <Mail className="h-7 w-7 text-[#38BDF8]" aria-hidden="true" />
              </div>

              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-[#F8FAFC]">Verification Link Sent</h2>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  We've sent an email verification link to:
                  <br />
                  <span className="font-semibold text-[#CBD5E1] break-all">{email}</span>
                </p>
                <p className="text-xs text-[#64748B]">
                  Click the link in the email to confirm your account and sign in.
                </p>
              </div>

              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={resendLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-[#1E293B] px-4 py-2 text-xs font-medium text-[#F8FAFC] transition-colors hover:bg-white/[0.05] disabled:opacity-50"
                >
                  {resendLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Resend Verification Email
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setSuccessMessage(null);
                    setMode('signIn');
                  }}
                  className="flex w-full items-center justify-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#F8FAFC] py-1.5 transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Sign In
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Security Notice */}
        <div className="text-center text-[11px] text-[#64748B]">
          Protected by Supabase Auth with PKCE and server-verified JWT token exchange.
        </div>
      </div>
    </div>
  );
}
