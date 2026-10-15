import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { app, controller } from './lib/chat/controller.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app');
mount(App, { target });

// Test hook for end-to-end tests: lets Playwright read and inject QR payloads instead of using
// a real camera. Only present in dev builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ramtalk = { app, controller };
}
