import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from './Sidebar';
import { WelcomeScreen } from './WelcomeScreen';
import { AppView, AudienceContext } from '../types/assistant';

test('public Welcome screen keeps the existing interface and presents sign-in before protected actions', () => {
  const markup = renderToStaticMarkup(createElement(WelcomeScreen, {
    audience: AudienceContext.General,
    authenticated: false,
    availableModels: [],
    selectedModel: '',
    modelAvailable: false,
    onChangeAudience: () => undefined,
    onChangeModel: () => undefined,
    onSelectQuickAction: () => undefined,
    onSubmitQuestion: () => undefined,
    onSignIn: () => undefined,
    onOpenMobileSidebar: () => undefined,
  }));

  assert.match(markup, /UpToSkills AI Support Assistant/);
  assert.match(markup, /Common UpToSkills Support Topics/);
  assert.match(markup, /Sign in \/ Create account/);
  assert.match(markup, /Sign in to ask/);
});

test('guest sidebar keeps the welcome route visible and omits private navigation', () => {
  const markup = renderToStaticMarkup(createElement(Sidebar, {
    conversations: [],
    activeConversationId: null,
    activeView: AppView.Welcome,
    audience: AudienceContext.General,
    collapsed: false,
    mobileOpen: false,
    authenticated: false,
    onSelectView: () => undefined,
    onSelectConversation: () => undefined,
    onNewConversation: () => undefined,
    onChangeAudience: () => undefined,
    onToggleCollapse: () => undefined,
    onCloseMobile: () => undefined,
    showHrEscalations: false,
    showHrMeetings: false,
    onSignIn: () => undefined,
  }));

  assert.match(markup, /Welcome &amp; Topics/);
  assert.match(markup, /Sign in to start/);
  assert.doesNotMatch(markup, /Conversation History|Human Support|Meeting Requests/);
});
