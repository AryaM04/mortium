// Top-level router. See docs/architecture.md section 7 and the M1 build
// notes: /app is protected (redirect to /login when signed out), every
// other auth page is public.
import { lazy, Suspense, useEffect } from "react";
import { Redirect, Route, Switch } from "wouter";
import { AuthCallbackPage } from "./pages/AuthCallbackPage.js";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.js";
import { VerifyEmailPage } from "./pages/VerifyEmailPage.js";
import { AppShell } from "./pages/AppShell.js";
import { InvitePage } from "./pages/InvitePage.js";
const DownloadPage = lazy(() => import("./pages/DownloadPage.js"));
import { session } from "./lib/session.js";
import { useSession } from "./lib/useSession.js";
import { startAutoIdle } from "./lib/presence.js";
// Imported for its side effect: it wires the gateway connection to the
// session store as soon as the app loads.
import "./lib/realtime.js";
// Also for their side effects: the synced settings load after READY, the
// desktop notifications watch new messages, and the ring sound watches
// incoming calls.
import "./lib/settings.js";
import "./lib/notifications.js";
import "./lib/ring.js";

function FullPageSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-canvas">
      <span className="text-muted">Loading...</span>
    </div>
  );
}

function ProtectedApp() {
  const status = useSession((s) => s.status);

  if (status === "loading") {
    return <FullPageSpinner />;
  }
  if (status === "signedOut") {
    return <Redirect to="/login" />;
  }
  return <AppShell />;
}

export function App() {
  useEffect(() => {
    void session.store.getState().init();
    startAutoIdle();
  }, []);

  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/auth/callback" component={AuthCallbackPage} />
      <Route path="/download">
        <Suspense fallback={<FullPageSpinner />}>
          <DownloadPage />
        </Suspense>
      </Route>
      <Route path="/invite/:code" component={InvitePage} />
      <Route path="/app/:guildId?/:channelId?" component={ProtectedApp} />
      <Route>
        <Redirect to="/app" />
      </Route>
    </Switch>
  );
}
