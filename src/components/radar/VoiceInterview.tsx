// D — Voice mock interview with ElevenLabs (owner: Matilde).
// 1. POST /interview/{id}/start {mode: "voice"} -> same 6-question plan as the text interview
// 2. GET /voice/signed-url -> short-lived URL (the API key never leaves the backend)
// 3. ElevenLabs call: the agent asks the plan questions (dynamic variables)
// 4. POST /interview/{id}/voice-transcript + POST /interview/{id}/feedback -> <Feedback/>
// Microphone denied or voice unavailable -> the user can continue in text mode.
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { Bot, Keyboard, Loader2, Mic, MicOff, PhoneOff, Sparkles, User } from "lucide-react";
import { api } from "@/api";
import type {
  ApplicationOut,
  InterviewFeedback,
  InterviewQuestion,
  TranscriptTurn,
  VoiceTurn,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/radar/shared";
import { cn } from "@/lib/utils";

export type VoiceResult = {
  plan: InterviewQuestion[];
  transcript: TranscriptTurn[];
  feedback: InterviewFeedback;
};

type Props = {
  app: ApplicationOut;
  onUseText: () => void;
  onFeedback: (result: VoiceResult) => void;
};

export default function VoiceInterview(props: Props) {
  const [isMuted, setIsMuted] = useState(true);
  return (
    <ConversationProvider isMuted={isMuted} onMutedChange={setIsMuted}>
      <VoiceCall {...props} resetMute={() => setIsMuted(true)} setMute={setIsMuted} />
    </ConversationProvider>
  );
}

type Phase = "ready" | "preparing" | "live" | "ended" | "evaluating";

type CaptionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type CaptionRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: CaptionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type CaptionWindow = Window & {
  SpeechRecognition?: new () => CaptionRecognition;
  webkitSpeechRecognition?: new () => CaptionRecognition;
};

function VoiceCall({
  app,
  onUseText,
  onFeedback,
  resetMute,
  setMute,
}: Props & {
  resetMute: () => void;
  setMute: (muted: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [problem, setProblem] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const turnsRef = useRef<VoiceTurn[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<CaptionRecognition | null>(null);
  const activityTimerRef = useRef<number | null>(null);
  const connectionTimerRef = useRef<number | null>(null);
  const startAttemptRef = useRef(0);
  const [liveText, setLiveText] = useState("");

  function stopUserActivity() {
    if (activityTimerRef.current === null) return;
    window.clearInterval(activityTimerRef.current);
    activityTimerRef.current = null;
  }

  function stopConnectionTimer() {
    if (connectionTimerRef.current !== null) window.clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
  }

  function stopCaptions() {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch {
      /* Caption failure must not interrupt the call. */
    }
  }

  const conversation = useConversation({
    onConnect: () => {
      if (connectionTimerRef.current === null) return;
      stopConnectionTimer();
      setProblem(null);
      setPhase((p) => (p === "preparing" ? "live" : p));
    },
    onMessage: ({ message, source }) => {
      const raw = message?.trim() ?? "";
      const text =
        source === "ai" ? raw.replace(/\[[A-Za-z][A-Za-z ,'-]{0,40}\]\s*/g, "").trim() : raw;
      if (!text) return;
      if (source === "user") setLiveText("");
      const turn: VoiceTurn = {
        role: source === "ai" ? "interviewer" : "candidate",
        content: text,
      };
      turnsRef.current = [...turnsRef.current, turn];
      setTurns(turnsRef.current);
    },
    onDisconnect: () => {
      stopConnectionTimer();
      stopUserActivity();
      stopCaptions();
      setLiveText("");
      resetMute();
      setPhase((p) => (p === "live" ? "ended" : p === "preparing" ? "ready" : p));
    },
    onError: (message) => {
      stopConnectionTimer();
      stopUserActivity();
      stopCaptions();
      resetMute();
      endSession();
      setPhase((p) => (p === "preparing" ? "ready" : p === "live" ? "ended" : p));
      setProblem(`Voice isn't available right now (${message}). You can continue in text mode.`);
    },
  });

  const sendUserActivity = conversation.sendUserActivity;
  useEffect(() => {
    if (phase !== "live" || conversation.isMuted) return;
    const notify = () => {
      try {
        sendUserActivity();
      } catch {
        stopUserActivity();
      }
    };
    // Hold the agent's turn while the candidate has explicitly opened the mic.
    activityTimerRef.current = window.setInterval(notify, 1000);
    notify();
    return stopUserActivity;
  }, [phase, conversation.isMuted, sendUserActivity]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, liveText]);

  // end the call if the user leaves the page
  const endSession = conversation.endSession;
  useEffect(
    () => () => {
      startAttemptRef.current += 1;
      stopConnectionTimer();
      stopUserActivity();
      stopCaptions();
      void endSession();
    },
    [endSession],
  );

  const answered = turns.filter((t) => t.role === "candidate").length;

  async function start() {
    const attempt = ++startAttemptRef.current;
    stopConnectionTimer();
    stopUserActivity();
    setProblem(null);
    resetMute();
    stopCaptions();
    setLiveText("");
    setPhase("preparing");
    // 1. microphone permission first: clear message if it is blocked
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (attempt !== startAttemptRef.current) return;
    } catch {
      if (attempt !== startAttemptRef.current) return;
      setPhase("ready");
      setProblem(
        "Microphone access was blocked. Allow the microphone in your browser (icon in the address bar), or continue in text mode.",
      );
      return;
    }
    try {
      // 2. signed URL first: if voice is not configured we do not create an interview
      const { signed_url } = await api.getVoiceSignedUrl();
      if (attempt !== startAttemptRef.current) return;
      // 3. same plan as the text interview
      const started = await api.startInterview(app.id, "voice");
      if (attempt !== startAttemptRef.current) return;
      turnsRef.current = [];
      setTurns([]);
      const firstName = (app.snapshot?.cv.name ?? app.cv.name ?? "").split(" ")[0] || "there";
      connectionTimerRef.current = window.setTimeout(() => {
        stopConnectionTimer();
        endSession();
        resetMute();
        setPhase("ready");
        setProblem("The voice connection timed out. Try again or continue in text mode.");
      }, 30000);
      // The SDK returns void: onConnect, not this return value, signals readiness.
      conversation.startSession({
        signedUrl: signed_url,
        dynamicVariables: {
          first_message: started.message,
          candidate_name: firstName,
          job_title: app.job.title,
          company: app.job.company ?? "the company",
          questions: started.plan.map((q, i) => `${i + 1}. ${q.question}`).join("\n"),
        },
      });
    } catch (e) {
      if (attempt !== startAttemptRef.current) return;
      stopConnectionTimer();
      setPhase("ready");
      setProblem(
        `Voice isn't available right now (${e instanceof Error ? e.message : String(e)}). You can continue in text mode.`,
      );
    }
  }

  function hangUp() {
    stopConnectionTimer();
    stopUserActivity();
    stopCaptions();
    setLiveText("");
    setMute(true);
    conversation.endSession();
    setPhase("ended");
  }

  function startAnswer() {
    if (phase !== "live" || conversation.isSpeaking || !conversation.isMuted) return;
    setMute(false);
    setLiveText("");
    const speechWindow = window as CaptionWindow;
    const SR = speechWindow.webkitSpeechRecognition || speechWindow.SpeechRecognition;
    if (!SR) return;
    try {
      const rec = new SR();
      recognitionRef.current = rec;
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (event) => {
        if (recognitionRef.current !== rec) return;
        const caption = Array.from(event.results)
          .map((r) => r[0]?.transcript ?? "")
          .join(" ");
        setLiveText(
          caption
            .replace(
              /\b(mm+-?hmm+|uh-?huh|u+h+m*|u+m+|h+u+m+|h+m+|m+h*m+|e+r+m+|e+h+m*|a+h+)\b[,.…]*\s*/gi,
              "",
            )
            .replace(/\s{2,}/g, " ")
            .trim(),
        );
      };
      rec.onerror = () => {
        stopCaptions();
        setLiveText("");
      };
      rec.onend = () => {
        if (recognitionRef.current === rec) recognitionRef.current = null;
      };
      rec.start();
    } catch {
      stopCaptions(); // Optional captions: ElevenLabs audio continues normally.
    }
  }

  function finishAnswer() {
    stopUserActivity();
    setMute(true);
    stopCaptions();
  }

  async function getFeedback() {
    setProblem(null);
    setPhase("evaluating");
    try {
      const saved = await api.saveVoiceTranscript(app.id, turnsRef.current);
      const feedback = await api.interviewFeedback(app.id);
      onFeedback({ plan: saved.plan, transcript: saved.transcript, feedback });
    } catch (e) {
      setPhase("ended");
      setProblem(`Couldn't get the feedback: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <Panel className="mx-auto max-w-3xl">
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <div
          className={cn(
            "flex size-14 items-center justify-center rounded-full transition-colors",
            phase === "live" &&
              conversation.isSpeaking &&
              "bg-primary text-primary-foreground animate-pulse",
            phase === "live" && !conversation.isSpeaking && "bg-primary-soft text-primary",
            phase !== "live" && "bg-muted text-muted-foreground",
          )}
        >
          {phase === "live" && !conversation.isMuted ? (
            <Mic className="size-6" />
          ) : (
            <MicOff className="size-6" />
          )}
        </div>
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">Voice interview</h2>
          <p className="text-sm text-muted-foreground">
            {phase === "ready" &&
              "Practise six core topics from your application, with follow-up questions based on your answers."}
            {phase === "preparing" && "Preparing your questions and connecting…"}
            {phase === "live" &&
              (conversation.isSpeaking
                ? "The interviewer is speaking…"
                : conversation.isMuted
                  ? "Microphone off. Take your time, then press Start answer."
                  : "Microphone on — press Done when you finish.") +
                (answered ? ` · ${answered} response${answered === 1 ? "" : "s"} recorded` : "")}
            {phase === "ended" &&
              (answered
                ? "Call ended. Get your feedback on the answers you gave."
                : "Call ended before any answer.")}
            {phase === "evaluating" && "Evaluating your answers (about 10–15 s)…"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUseText}
          disabled={phase === "preparing" || phase === "live" || phase === "evaluating"}
        >
          <Keyboard /> Use text instead
        </Button>
      </div>

      {problem && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
          {problem}
          <div className="mt-2">
            <Button size="sm" variant="outline" className="bg-card" onClick={onUseText}>
              <Keyboard /> Continue in text mode
            </Button>
          </div>
        </div>
      )}

      {(turns.length > 0 || liveText) && (
        <div className="mb-4 max-h-[45vh] space-y-3 overflow-y-auto rounded-lg border bg-muted/30 p-4">
          {turns.map((t, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-2 text-sm",
                t.role === "candidate" && "flex-row-reverse text-right",
              )}
            >
              {t.role === "candidate" ? (
                <User className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <p
                className={cn(
                  "max-w-[85%]",
                  t.role === "candidate" ? "text-foreground" : "text-foreground/80",
                )}
              >
                {t.content}
              </p>
            </div>
          ))}
          {liveText && (
            <div
              className="flex flex-row-reverse gap-2 text-right text-sm"
              role="status"
              aria-label="Your live captions"
            >
              <User className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="max-w-[85%] rounded-lg border border-dashed border-primary/30 bg-primary-soft p-3">
                <div className="mb-1 text-xs font-semibold text-primary">
                  {conversation.isMuted ? "You (transcribing…)" : "You (speaking…)"}
                </div>
                <p>{liveText}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Browser preview · awaiting ElevenLabs transcript
                </p>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {(phase === "ready" || phase === "preparing") && (
          <Button size="lg" className="w-full" disabled={phase === "preparing"} onClick={start}>
            {phase === "preparing" ? (
              <>
                <Loader2 className="animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <Mic /> Start voice interview
              </>
            )}
          </Button>
        )}
        {phase === "live" && (
          <>
            {conversation.isMuted ? (
              <Button
                size="lg"
                className="flex-1"
                disabled={conversation.isSpeaking}
                onClick={startAnswer}
              >
                <Mic /> Start answer
              </Button>
            ) : (
              <Button size="lg" className="flex-1" onClick={finishAnswer}>
                <MicOff /> Done
              </Button>
            )}
            <Button size="lg" variant="destructive" onClick={hangUp}>
              <PhoneOff /> End interview
            </Button>
          </>
        )}
        {(phase === "ended" || phase === "evaluating") && (
          <>
            <Button
              size="lg"
              className="flex-1"
              disabled={!answered || phase === "evaluating"}
              onClick={getFeedback}
            >
              {phase === "evaluating" ? <Loader2 className="animate-spin" /> : <Sparkles />} Get my
              feedback
            </Button>
            <Button size="lg" variant="outline" disabled={phase === "evaluating"} onClick={start}>
              <Mic /> Try again
            </Button>
          </>
        )}
      </div>
      {phase === "ready" && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Your microphone starts off. Press Start answer to speak, then Done to let the interviewer
          continue. Live captions appear where supported; feedback always uses the ElevenLabs
          transcript.
        </p>
      )}
    </Panel>
  );
}
