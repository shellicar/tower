import { mount } from 'svelte';
import App from './App.svelte';
import { tower } from './lib/tower.svelte';

tower.connect();

export default mount(App, { target: document.getElementById('app')! });
