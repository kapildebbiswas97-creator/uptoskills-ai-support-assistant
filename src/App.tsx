import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatConsole } from './components/ChatConsole';
import { ConversationHistory } from './components/ConversationHistory';
import { HumanSupportEscalation } from './components/HumanSupportEscalation';
import { HrEscalationDashboard } from './components/HrEscalationDashboard';
import { MeetingRequests } from './components/MeetingRequests';
import { HrMeetingDashboard } from './components/HrMeetingDashboard';
import { Sidebar } from './components/Sidebar';
import { WelcomeScreen } from './components/WelcomeScreen';
import {
  AppView,
  AIModelOption,
  AssistantMessage,
  AudienceContext,
  ChatHistoryTurn,
  ConversationThread,
  HelpTopicId,
  MessageRole,
  PdfAttachmentPayload,
  QuickActionItem,
} from './types/assistant';
import type { AssistantReplyResult } from './utils/assistantEngine';

const STORAGE_KEY = 'uptoskills-assistant-history-v1';
const AUDIENCE_STORAGE_KEY = 'uptoskills-assistant-audience-v1';
const MODEL_STORAGE_KEY = 'uptoskills-assistant-model-v1';

function loadStoredModel(): string {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function loadStoredConversations(): ConversationThread[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ConversationThread[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadStoredAudience(): AudienceContext {
  try {
    const raw = window.localStorage.getItem(AUDIENCE_STORAGE_KEY);
    if (
      raw &&
      Object.values(AudienceContext).includes(raw as AudienceContext)
    ) {
      return raw as AudienceContext;
    }
  } catch {
    // Ignore storage errors
  }
  return AudienceContext.General;
}

function formatTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`;
}

export default function App() {
  const [conversations, setConversations] = useState<ConversationThread[]>(
    loadStoredConversations
  );
  const [audience, setAudience] = useState<AudienceContext>(loadStoredAudience);
  const [availableModels, setAvailableModels] = useState<AIModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(loadStoredModel);
  const [modelAvailable, setModelAvailable] = useState(false);
  const [activeView, setActiveView] = useState<AppView>(AppView.Welcome);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null
  );
  const [session, setSession] = useState<{ checked: boolean; authenticated: boolean; roles: string[]; message: string }>({ checked: false, authenticated: false, roles: [], message: '' });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] =
    useState<AssistantMessage | null>(null);
  const [errorState, setErrorState] = useState<{
    message: string;
    failedPrompt: string;
    topicId?: HelpTopicId;
    failedAttachment?: PdfAttachmentPayload;
  } | null>(null);

  const loadingTimeoutRef = useRef<number | null>(null);
  const requestAbortControllerRef = useRef<AbortController | null>(null);
  const pendingFinalRef = useRef<{
    conversationId: string;
    message: AssistantMessage;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/session', { credentials: 'same-origin' })
      .then(async (response) => {
        const result = await response.json() as { roles?: string[]; error?: string };
        if (!active) return;
        if (!response.ok) {
          setSession({ checked: true, authenticated: false, roles: [], message: result.error || 'A verified sign-in is required.' });
          return;
        }
        setSession({ checked: true, authenticated: true, roles: Array.isArray(result.roles) ? result.roles : [], message: '' });
      })
      .catch(() => {
        if (active) setSession({ checked: true, authenticated: false, roles: [], message: 'The sign-in service could not be reached.' });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      // Ignore storage quota errors
    }
  }, [conversations]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUDIENCE_STORAGE_KEY, audience);
    } catch {
      // Ignore storage quota errors
    }
  }, [audience]);

  useEffect(() => {
    let active = true;
    void fetch('/api/models')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load models');
        return await response.json() as { models?: AIModelOption[]; defaultModel?: string; modelAvailable?: boolean };
      })
      .then((catalog) => {
        if (!active || !Array.isArray(catalog.models)) return;
        const available = Boolean(catalog.modelAvailable) && catalog.models.length > 0;
        setModelAvailable(available);
        setAvailableModels(catalog.models);
        setSelectedModel((current) => {
          if (!available) return '';
          if (catalog.models?.some((model) => model.id === current)) return current;
          if (catalog.defaultModel && catalog.models?.some((model) => model.id === catalog.defaultModel)) {
            return catalog.defaultModel;
          }
          return catalog.models?.[0]?.id ?? '';
        });
      })
      .catch(() => {
        if (!active) return;
        setModelAvailable(false);
        setAvailableModels([]);
        setSelectedModel('');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      if (selectedModel) {
        window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
      } else {
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }, [selectedModel]);

  const clearTimers = useCallback(() => {
    requestAbortControllerRef.current?.abort();
    requestAbortControllerRef.current = null;
    if (loadingTimeoutRef.current !== null) {
      window.clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );

  const finalizeStream = useCallback(() => {
    clearTimers();
    const pending = pendingFinalRef.current;
    if (pending) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === pending.conversationId
            ? {
                ...c,
                updatedAt: formatTime(),
                messages: [...c.messages, pending.message],
              }
            : c
        )
      );
      pendingFinalRef.current = null;
    }
    setIsLoading(false);
    setStreamingMessage(null);
  }, [clearTimers]);

  const handleCancelOrStop = useCallback(() => {
    clearTimers();
    if (streamingMessage && pendingFinalRef.current) {
      const targetId = pendingFinalRef.current.conversationId;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? {
                ...c,
                updatedAt: formatTime(),
                messages: [...c.messages, streamingMessage],
              }
            : c
        )
      );
    }
    pendingFinalRef.current = null;
    setIsLoading(false);
    setStreamingMessage(null);
  }, [clearTimers, streamingMessage]);

  const dispatchAssistantResponse = useCallback(
    (conversationId: string, prompt: string, topicId?: HelpTopicId, history: ChatHistoryTurn[] = [], attachment?: PdfAttachmentPayload) => {
      clearTimers();
      setErrorState(null);
      setIsLoading(true);

      loadingTimeoutRef.current = window.setTimeout(async () => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setIsLoading(false);
          setErrorState({
            message:
              'Your browser appears offline. Reconnect and click Retry to continue, or contact UpToSkills human support.',
            failedPrompt: prompt,
            topicId,
            failedAttachment: attachment,
          });
          return;
        }

        const requestController = new AbortController();
        requestAbortControllerRef.current = requestController;
        const messageId = `msg-a-${Date.now()}`;
        const timestamp = formatTime();
        let streamedContent = '';
        const completedReplyRef: { value: AssistantReplyResult | null } = { value: null };
        const partialMessage: AssistantMessage = {
          id: messageId,
          role: MessageRole.Assistant,
          content: '',
          timestamp,
        };
        try {
          const response = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({ message: prompt, conversationId, audience, topicId, history, attachment, model: selectedModel }),
            signal: requestController.signal,
          });
          if (!response.ok) {
            let errorMessage = `Chat request failed with status ${response.status}`;
            try {
              const payload = await response.json() as { error?: string };
              if (payload.error) errorMessage = payload.error;
            } catch {
              // Keep the generic status message when the server has no JSON error body.
            }
            throw new Error(errorMessage);
          }
          if (!response.body) throw new Error('The assistant stream was empty');

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const processFrame = (frame: string) => {
            const lines = frame.split(/\r?\n/);
            const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
            const dataLine = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (!eventName || !dataLine) return;
            const payload = JSON.parse(dataLine) as {
              text?: string;
              reply?: AssistantReplyResult;
              message?: string;
            };

            if (eventName === 'delta' && typeof payload.text === 'string') {
              streamedContent += payload.text;
              const updatedMessage = { ...partialMessage, content: streamedContent };
              pendingFinalRef.current = { conversationId, message: updatedMessage };
              setIsLoading(false);
              setStreamingMessage(updatedMessage);
            } else if (eventName === 'complete') {
              completedReplyRef.value = payload.reply ?? null;
            } else if (eventName === 'error') {
              throw new Error(payload.message || 'The assistant stream failed');
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) processFrame(frame);
            if (done) break;
          }
          if (buffer.trim()) processFrame(buffer);
          if (!completedReplyRef.value) throw new Error('The assistant stream did not complete');
        } catch (error) {
          if (requestController.signal.aborted) return;
          pendingFinalRef.current = null;
          setStreamingMessage(null);
          setIsLoading(false);
          setErrorState({
            message: error instanceof Error && !error.message.includes('fetch')
              ? error.message
              : 'The local support service could not be reached. Start the Express server and retry, or contact UpToSkills human support.',
            failedPrompt: prompt,
            topicId,
            failedAttachment: attachment,
          });
          return;
        }
        if (requestAbortControllerRef.current === requestController) {
          requestAbortControllerRef.current = null;
        }
        const finalReply = completedReplyRef.value as AssistantReplyResult;
        const fullMessage: AssistantMessage = {
          ...finalReply,
          id: messageId,
          role: MessageRole.Assistant,
          content: finalReply.content,
          timestamp,
        };

        pendingFinalRef.current = {
          conversationId,
          message: fullMessage,
        };

        setIsLoading(false);
        setStreamingMessage(fullMessage);
        finalizeStream();
      }, 240);
    },
    [audience, clearTimers, finalizeStream, selectedModel]
  );

  const startNewConversationWithPrompt = useCallback(
    (prompt: string, topicId?: HelpTopicId, attachment?: PdfAttachmentPayload) => {
      const convId = `conv-${Date.now()}`;
      const title =
        prompt.length > 56 ? `${prompt.slice(0, 53).trim()}...` : prompt;
      const userMsg: AssistantMessage = {
        id: `msg-u-${Date.now()}`,
        role: MessageRole.User,
        content: attachment ? `${prompt}\n\nAttached PDF: ${attachment.name}` : prompt,
        timestamp: formatTime(),
      };

      const newConv: ConversationThread = {
        id: convId,
        title,
        audience,
        topicId,
        updatedAt: formatTime(),
        messages: [userMsg],
      };

      setConversations((prev) => [newConv, ...prev]);
      setActiveConversationId(convId);
      setActiveView(AppView.Chat);
      dispatchAssistantResponse(convId, prompt, topicId, [], attachment);
    },
    [audience, dispatchAssistantResponse]
  );

  const handleSendInActiveChat = useCallback(
    (prompt: string, topicId?: HelpTopicId, attachment?: PdfAttachmentPayload) => {
      if (!activeConversation) {
        startNewConversationWithPrompt(prompt, topicId, attachment);
        return;
      }

      const convId = activeConversation.id;
      const userMsg: AssistantMessage = {
        id: `msg-u-${Date.now()}`,
        role: MessageRole.User,
        content: attachment ? `${prompt}\n\nAttached PDF: ${attachment.name}` : prompt,
        timestamp: formatTime(),
      };

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                audience,
                updatedAt: formatTime(),
                messages: [...c.messages, userMsg],
              }
            : c
        )
      );

      const history = activeConversation.messages.slice(-12).map((message): ChatHistoryTurn => ({
        role: message.role === MessageRole.User ? 'user' : 'assistant',
        content: message.content.slice(0, 2000),
      }));
      dispatchAssistantResponse(convId, prompt, topicId, history, attachment);
    },
    [
      activeConversation,
      audience,
      dispatchAssistantResponse,
      startNewConversationWithPrompt,
    ]
  );

  const handleRetryFailed = useCallback(() => {
    if (!activeConversation || !errorState) return;
    dispatchAssistantResponse(
      activeConversation.id,
      errorState.failedPrompt,
      errorState.topicId,
      activeConversation.messages.slice(0, -1).slice(-12).map((message): ChatHistoryTurn => ({
        role: message.role === MessageRole.User ? 'user' : 'assistant',
        content: message.content.slice(0, 2000),
      })),
      errorState.failedAttachment
    );
  }, [activeConversation, dispatchAssistantResponse, errorState]);

  const handleSelectQuickAction = useCallback(
    (action: QuickActionItem) => {
      if (action.opensEscalation) {
        setActiveView(AppView.Escalation);
        return;
      }
      if (action.prompt) {
        startNewConversationWithPrompt(action.prompt, action.topicId);
      }
    },
    [startNewConversationWithPrompt]
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[#0B1220] text-[#F8FAFC]">
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeView={activeView}
        audience={audience}
        showHrEscalations={session.authenticated && session.roles.includes('support_agent')}
        showHrMeetings={session.authenticated && session.roles.includes('support_agent')}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        onSelectView={(view) => {
          setErrorState(null);
          setActiveView(view);
        }}
        onSelectConversation={(id) => {
          setErrorState(null);
          setActiveConversationId(id);
          setActiveView(AppView.Chat);
        }}
        onNewConversation={() => {
          clearTimers();
          setIsLoading(false);
          setStreamingMessage(null);
          setErrorState(null);
          setActiveConversationId(null);
          setActiveView(AppView.Welcome);
        }}
        onChangeAudience={setAudience}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      {activeView === AppView.Welcome && (
        <WelcomeScreen
          audience={audience}
          availableModels={availableModels}
          selectedModel={selectedModel}
          modelAvailable={modelAvailable}
          onChangeAudience={setAudience}
          onChangeModel={setSelectedModel}
          onSelectQuickAction={handleSelectQuickAction}
          onSubmitQuestion={(q, attachment) => startNewConversationWithPrompt(q, undefined, attachment)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      )}

      {activeView === AppView.Chat && activeConversation && (
        <ChatConsole
          conversation={activeConversation}
          audience={audience}
          availableModels={availableModels}
          selectedModel={selectedModel}
          modelAvailable={modelAvailable}
          isLoading={isLoading}
          streamingMessage={streamingMessage}
          errorState={errorState}
          onChangeAudience={setAudience}
          onChangeModel={setSelectedModel}
          onSendMessage={handleSendInActiveChat}
          onCancelOrStop={handleCancelOrStop}
          onRetryFailed={handleRetryFailed}
          onOpenEscalation={() => setActiveView(AppView.Escalation)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      )}

      {activeView === AppView.Chat && !activeConversation && (
        <WelcomeScreen
          audience={audience}
          availableModels={availableModels}
          selectedModel={selectedModel}
          modelAvailable={modelAvailable}
          onChangeAudience={setAudience}
          onChangeModel={setSelectedModel}
          onSelectQuickAction={handleSelectQuickAction}
          onSubmitQuestion={(q, attachment) => startNewConversationWithPrompt(q, undefined, attachment)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      )}

      {activeView === AppView.History && (
        <ConversationHistory
          conversations={conversations}
          onOpenConversation={(id) => {
            setErrorState(null);
            setActiveConversationId(id);
            setActiveView(AppView.Chat);
          }}
          onDeleteConversation={(id) => {
            setConversations((prev) => prev.filter((c) => c.id !== id));
            if (activeConversationId === id) {
              setActiveConversationId(null);
            }
          }}
          onClearAll={() => {
            setConversations([]);
            setActiveConversationId(null);
          }}
          onStartNew={() => setActiveView(AppView.Welcome)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      )}

      {activeView === AppView.Escalation && (
        <HumanSupportEscalation
          audience={audience}
          conversationId={activeConversationId}
          authenticated={session.checked && session.authenticated}
          authMessage={session.message || 'A verified account is required to submit or track an HR escalation. No ticket has been created.'}
          showHrEscalations={session.authenticated && session.roles.includes('support_agent')}
          onOpenHrEscalations={() => setActiveView(AppView.HrEscalations)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      )}

      {activeView === AppView.HrEscalations && session.authenticated && session.roles.includes('support_agent') && (
        <HrEscalationDashboard onOpenMobileSidebar={() => setMobileSidebarOpen(true)} />
      )}
      {activeView === AppView.HrEscalations && (!session.authenticated || !session.roles.includes('support_agent')) && (
        <main role="alert" className="flex min-w-0 flex-1 items-center justify-center bg-[#0B1220] p-6 text-sm text-[#CBD5E1]">
          HR escalation access requires a verified support-agent role. The API enforces this permission independently.
        </main>
      )}
      {activeView === AppView.MeetingRequests && (
        <MeetingRequests authenticated={session.checked && session.authenticated} authMessage={session.message || 'A verified account is required. This environment does not provide a browser sign-in flow.'} conversationId={activeConversationId} onOpenMobileSidebar={() => setMobileSidebarOpen(true)} />
      )}
      {activeView === AppView.HrMeetingRequests && session.authenticated && session.roles.includes('support_agent') && (
        <HrMeetingDashboard onOpenMobileSidebar={() => setMobileSidebarOpen(true)} />
      )}
      {activeView === AppView.HrMeetingRequests && (!session.authenticated || !session.roles.includes('support_agent')) && (
        <main role="alert" className="flex min-w-0 flex-1 items-center justify-center bg-[#0B1220] p-6 text-sm text-[#CBD5E1]">
          HR meeting access requires a verified support-agent role. The API enforces this permission independently.
        </main>
      )}
    </div>
  );
}
