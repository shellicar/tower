import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
// The composition root: constructs the transport and concerns and connects.
import './lib/app';

export default mount(App, { target: document.getElementById('app')! });
