import {
  ChevronDown,
  CalendarDays,
  Compass,
  History,
  Inbox,
  LifeBuoy,
  LogIn,
  LogOut,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import {
  AppView,
  AudienceContext,
  ConversationThread,
} from '../types/assistant';
import { OFFICIAL_SUPPORT } from '../data/uptoskillsKnowledge';
import { BrandMark } from './BrandMark';

interface SidebarProps {
  conversations: ConversationThread[];
  activeConversationId: string | null;
  activeView: AppView;
  audience: AudienceContext;
  collapsed: boolean;
  mobileOpen: boolean;
  onSelectView: (view: AppView) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onChangeAudience: (audience: AudienceContext) => void;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  showHrEscalations: boolean;
  showHrMeetings: boolean;
  authenticated: boolean;
  onSignIn?: () => void;
  userEmail?: string;
  onSignOut?: () => void;
}

export function Sidebar({
  conversations,
  activeConversationId,
  activeView,
  audience,
  collapsed,
  mobileOpen,
  onSelectView,
  onSelectConversation,
  onNewConversation,
  onChangeAudience,
  onToggleCollapse,
  onCloseMobile,
  showHrEscalations,
  showHrMeetings,
  authenticated,
  onSignIn,
  userEmail,
  onSignOut,
}: SidebarProps) {
  const navItems: { id: AppView; label: string; icon: typeof Compass }[] = [
    { id: AppView.Welcome, label: 'Welcome & Topics', icon: Compass },
    ...(authenticated ? [
      { id: AppView.History, label: 'Conversation History', icon: History },
      { id: AppView.Escalation, label: 'Human Support', icon: LifeBuoy },
      { id: AppView.MeetingRequests, label: 'Meeting Requests', icon: CalendarDays },
    ] : []),
    ...(showHrEscalations ? [{ id: AppView.HrEscalations, label: 'HR Escalations', icon: Inbox }] : []),
    ...(showHrMeetings ? [{ id: AppView.HrMeetingRequests, label: 'HR Meetings', icon: CalendarDays }] : []),
  ];

  const renderContent = (isMobileDrawer: boolean) => (
    <div className="flex h-full flex-col border-r border-white/[0.08] bg-[#111827]">
      {/* Brand Header */}
      <div className="flex h-14 items-center justify-between gap-2 border-b border-white/[0.08] px-3.5 shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark className="h-8 w-[76px]" />
          {(!collapsed || isMobileDrawer) && (
          <div className="min-w-0">
            <span className="font-display text-[15px] font-bold tracking-tight text-[#F8FAFC] whitespace-nowrap block truncate">
              UpToSkills Support
            </span>
          </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isMobileDrawer ? (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation drawer"
              className="rounded-lg p-2 text-[#94A3B8] transition-colors hover:bg-[#1E293B] hover:text-[#F8FAFC]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
              className="rounded-lg p-2 text-[#94A3B8] transition-colors hover:bg-[#1E293B] hover:text-[#F8FAFC]"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Primary Action */}
      <div className="border-b border-white/[0.06] p-3">
        <button
          type="button"
          onClick={() => {
            onNewConversation();
            if (isMobileDrawer) onCloseMobile();
          }}
          aria-label={authenticated ? 'New Conversation' : 'Sign in to start'}
          title={collapsed && !isMobileDrawer ? (authenticated ? 'New Conversation' : 'Sign in to start') : undefined}
          className={`flex w-full items-center justify-center gap-2 rounded-lg bg-[#2563EB] py-2 text-xs font-semibold text-[#F8FAFC] transition-colors hover:bg-[#1D4ED8] whitespace-nowrap ${
            collapsed && !isMobileDrawer ? 'px-0' : 'px-3'
          }`}
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
          {(!collapsed || isMobileDrawer) && <span>{authenticated ? 'New Conversation' : 'Sign in to start'}</span>}
        </button>
      </div>

      {/* Screen Navigation */}
      <nav aria-label="Assistant navigation" className="border-b border-white/[0.06] p-2.5 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectView(item.id);
                if (isMobileDrawer) onCloseMobile();
              }}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed && !isMobileDrawer ? item.label : undefined}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'border border-[#2563EB]/40 bg-[#2563EB]/15 text-[#F8FAFC]'
                  : 'border border-transparent text-[#94A3B8] hover:bg-[#1E293B] hover:text-[#F8FAFC]'
              } ${collapsed && !isMobileDrawer ? 'justify-center px-0' : ''}`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${
                  isActive ? 'text-[#60A5FA]' : 'text-[#94A3B8]'
                }`}
                aria-hidden="true"
              />
              {(!collapsed || isMobileDrawer) && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Audience Context Preference */}
      {(!collapsed || isMobileDrawer) && (
        <div className="border-b border-white/[0.06] p-3 space-y-1.5">
          <label
            htmlFor={isMobileDrawer ? 'mobile-audience-select' : 'sidebar-audience-select'}
            className="block font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[#94A3B8]"
          >
            Audience Context
          </label>
          <div className="relative">
            <select
              id={isMobileDrawer ? 'mobile-audience-select' : 'sidebar-audience-select'}
              value={audience}
              onChange={(e) => onChangeAudience(e.target.value as AudienceContext)}
              className="w-full appearance-none rounded-lg border border-white/[0.08] bg-[#0B1220] py-1.5 pl-2.5 pr-8 text-xs text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30"
            >
              <option value={AudienceContext.Applicant}>Applicant</option>
              <option value={AudienceContext.Intern}>Intern</option>
              <option value={AudienceContext.CaptainOrLead}>Captain / Team Lead</option>
              <option value={AudienceContext.General}>General</option>
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]"
              aria-hidden="true"
            />
          </div>
          <p className="text-[11px] leading-snug text-[#94A3B8]">
            Conversational preference only. Does not verify identity or grant access.
          </p>
        </div>
      )}

      {/* Recent Conversations */}
      {authenticated && (!collapsed || isMobileDrawer) && (
        <div className="flex flex-1 flex-col overflow-hidden p-2.5">
          <div className="mb-1.5 flex items-center justify-between px-1.5">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[#94A3B8]">
              Recent Threads
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
              {conversations.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1">
            {conversations.length === 0 ? (
              <p className="px-2 py-4 text-xs text-[#94A3B8]">
                No saved conversations yet. Start a topic from the Welcome screen.
              </p>
            ) : (
              conversations.slice(0, 12).map((conv) => {
                const isSelected =
                  activeView === AppView.Chat && conv.id === activeConversationId;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => {
                      onSelectConversation(conv.id);
                      if (isMobileDrawer) onCloseMobile();
                    }}
                    className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      isSelected
                        ? 'border-white/[0.12] bg-[#1E293B]'
                        : 'border-transparent hover:bg-white/[0.03]'
                    }`}
                  >
                    <p className="text-xs font-medium text-[#F8FAFC] line-clamp-1">
                      {conv.title}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#94A3B8]">
                      <span className="truncate">{conv.audience}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums shrink-0">
                        {conv.updatedAt}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* User Account & Sign Out */}
      {(!collapsed || isMobileDrawer) && onSignOut && (
        <div className="border-t border-white/[0.06] px-3.5 py-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-[#CBD5E1] truncate">{userEmail || 'Account'}</p>
            <p className="text-[10px] text-[#64748B] truncate">Verified Session</p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="rounded p-1.5 text-[#94A3B8] hover:bg-white/[0.05] hover:text-red-400 transition-colors"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {collapsed && !isMobileDrawer && onSignOut && (
        <div className="border-t border-white/[0.06] p-2 flex justify-center">
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="rounded p-2 text-[#94A3B8] hover:bg-white/[0.05] hover:text-red-400 transition-colors"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {!authenticated && onSignIn && (!collapsed || isMobileDrawer) && (
        <div className="border-t border-white/[0.06] px-3.5 py-3">
          <p className="mb-2 text-[11px] leading-relaxed text-[#94A3B8]">Sign in to use the assistant and private support tools.</p>
          <button type="button" onClick={onSignIn} className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-[#1E293B] px-3 py-2 text-xs font-semibold text-[#F8FAFC] hover:bg-white/[0.08]"><LogIn className="h-4 w-4" aria-hidden="true" />Sign in</button>
        </div>
      )}
      {!authenticated && onSignIn && collapsed && !isMobileDrawer && (
        <div className="border-t border-white/[0.06] p-2 flex justify-center">
          <button type="button" onClick={onSignIn} aria-label="Sign in" title="Sign in" className="rounded p-2 text-[#94A3B8] hover:bg-white/[0.05] hover:text-white"><LogIn className="h-4 w-4" aria-hidden="true" /></button>
        </div>
      )}

      {/* Official Reference Footer */}
      {(!collapsed || isMobileDrawer) && (
        <div className="border-t border-white/[0.06] px-3.5 py-2.5 text-[11px] text-[#94A3B8]">
          <p className="font-medium text-[#cbd5e1]">{OFFICIAL_SUPPORT.brandName}</p>
          <p className="mt-0.5">Advisory & navigation guidance only</p>
        </div>
      )}
    </div>
  );

  return (
    <>
      <aside
        aria-label="Assistant sidebar"
        className={`hidden md:block shrink-0 transition-[width] duration-200 ${
          collapsed ? 'w-[64px]' : 'w-[268px]'
        }`}
      >
        {renderContent(false)}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button
            type="button"
            aria-label="Close navigation backdrop"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-black/65"
          />
          <aside
            aria-label="Mobile navigation drawer"
            className="relative z-10 h-full w-[280px] max-w-[85vw]"
          >
            {renderContent(true)}
          </aside>
        </div>
      )}
    </>
  );
}
