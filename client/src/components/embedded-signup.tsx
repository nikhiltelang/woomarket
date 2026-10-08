import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Facebook, KeyRound, Smartphone } from "lucide-react";
import type { PublicChannel } from "@shared/api-types";
import type { CompleteSignupInput, PublicSignupConfig, SignupMode } from "@shared/whatsapp-signup";
import { apiRequest, queryClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, useToast } from "@/components/ui/overlay";

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FacebookSdk {
  init(o: Record<string, unknown>): void;
  login(cb: (r: FbLoginResponse) => void, o: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

/** Loads Meta's JavaScript SDK once. */
function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdk = null;
      reject(new Error("Couldn't load Facebook. Check that ad blockers allow connect.facebook.net."));
    };
    document.body.appendChild(s);
  });
  return sdk;
}

class SignupCancelled extends Error {}

/**
 * Opens Meta's Embedded Signup popup and resolves with what the server needs. The login callback
 * (the code) and the session event (the account ids) arrive separately, in either order.
 */
async function runPopup(cfg: PublicSignupConfig, wanted: SignupMode): Promise<CompleteSignupInput> {
  if (cfg.simulated) {
    const n = () => String(Math.floor(1e14 + Math.random() * 9e14));
    return { code: "SIMULATED", wabaId: n(), phoneNumberId: n(), businessId: n(), mode: wanted };
  }
  const FB = await loadSdk(cfg.appId!, cfg.graphVersion);
  let onSession: (d: { event: string; data: Record<string, string> }) => void = () => {};
  const session = new Promise<{ event: string; data: Record<string, string> }>((resolve) => (onSession = resolve));
  const listener = (e: MessageEvent) => {
    if (typeof e.origin !== "string" || !/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
    try {
      const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (msg?.type === "WA_EMBEDDED_SIGNUP") onSession({ event: String(msg.event), data: msg.data ?? {} });
    } catch {
      /* other Facebook messages */
    }
  };
  window.addEventListener("message", listener);
  try {
    const code = await new Promise<string>((resolve, reject) => {
      FB.login(
        (r) => (r.authResponse?.code ? resolve(r.authResponse.code) : reject(new SignupCancelled("The Facebook window was closed before finishing."))),
        {
          config_id: cfg.configId,
          response_type: "code",
          override_default_response_type: true,
          // featureType selects the WhatsApp Business app flow on configurations that need it.
          extras: wanted === "coexistence" ? { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } : { setup: {} },
        },
      );
    });
    const s = await Promise.race([session, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    if (!s) throw new Error("Facebook didn't say which number was chosen. Please try again.");
    if (s.event === "CANCEL") throw new SignupCancelled(s.data.error_message || "The signup was cancelled.");
    if (s.event === "FINISH_ONLY_WABA" || !s.data.phone_number_id) throw new Error("The account was connected without a phone number. Run the signup again and add a number.");
    return {
      code,
      wabaId: s.data.waba_id,
      phoneNumberId: s.data.phone_number_id,
      businessId: s.data.business_id || undefined,
      mode: s.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ? "coexistence" : "cloud",
    };
  } finally {
    window.removeEventListener("message", listener);
  }
}

interface Result {
  data: PublicChannel;
  warnings: string[];
  pin: string | null;
}

/** "Connect with Facebook" buttons (shown in the Connect number dialog). */
export function EmbeddedSignupButtons({ onConnected }: { onConnected: (r: Result) => void }) {
  const toast = useToast();
  const cfg = useQuery<{ data: PublicSignupConfig }>({ queryKey: ["/api/whatsapp-signup/config"] });
  const connect = useMutation({
    mutationFn: async (mode: SignupMode) => {
      const input = await runPopup(cfg.data!.data, mode);
      return apiRequest<Result>("POST", "/api/whatsapp-signup/complete", input);
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      onConnected(r);
    },
    onError: (err) => {
      if (err instanceof SignupCancelled) toast({ title: "Signup not finished", description: err.message });
      else toast({ title: "Could not connect the number", description: (err as Error).message, variant: "error" });
    },
  });
  const c = cfg.data?.data;
  if (!c?.enabled) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <p className="text-sm font-medium">Connect with Facebook <span className="font-normal text-fg-muted">(recommended)</span></p>
        <p className="mt-0.5 text-xs text-fg-muted">Log in with Facebook, pick or create your WhatsApp Business account and number. No IDs or tokens to copy.{c.simulated && " Test mode: no Meta app is configured, so a simulated number is created."}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => connect.mutate("cloud")} loading={connect.isPending && connect.variables === "cloud"} disabled={connect.isPending}>
          <Facebook className="h-4 w-4" /> Connect with Facebook
        </Button>
        {c.coexistence && (
          <Button variant="outline" onClick={() => connect.mutate("coexistence")} loading={connect.isPending && connect.variables === "coexistence"} disabled={connect.isPending}>
            <Smartphone className="h-4 w-4" /> Use my WhatsApp Business app number
          </Button>
        )}
      </div>
      {c.coexistence && <p className="text-xs text-fg-muted">Already chatting with customers in the WhatsApp Business app? Keep using it on your phone: your contacts and recent chats are copied here, and replies sent from either place show up in both.</p>}
    </div>
  );
}

/** Shown once after connecting: warnings and the two-step verification PIN. */
export function SignupResultDialog({ result, onClose }: { result: Result | null; onClose: () => void }) {
  const ch = result?.data;
  return (
    <Dialog open={Boolean(result)} onClose={onClose} title={ch ? `${ch.name} is connected` : ""} footer={<Button onClick={onClose}>Done</Button>}>
      {ch && (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {ch.phoneNumber} · {ch.isCoexistence ? "shared with the WhatsApp Business app" : "WhatsApp Cloud API"}
          </p>
          {ch.isCoexistence && <p className="rounded-md bg-info-soft px-3 py-2 text-info">Your contacts and chat history are being copied (this can take a few minutes; history needs the approval you gave in the WhatsApp Business app). Progress shows on the number's card.</p>}
          {result!.pin && (
            <div className="rounded-md border border-border p-3">
              <p className="flex items-center gap-1.5 font-medium"><KeyRound className="h-4 w-4" /> Two-step verification PIN: <code className="text-base tracking-widest">{result!.pin}</code></p>
              <p className="mt-1 text-xs text-fg-muted">We registered the number with this PIN. Keep it safe: Meta asks for it if the number is ever moved. Admins can show it again from the number's card.</p>
            </div>
          )}
          {result!.warnings.map((w) => <p key={w} className="rounded-md bg-warning-soft px-3 py-2 text-warning">{w}</p>)}
        </div>
      )}
    </Dialog>
  );
}
