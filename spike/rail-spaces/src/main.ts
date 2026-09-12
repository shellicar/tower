import { mount } from 'svelte';
import App from './App.svelte';
import Variants from './Variants.svelte';
import './app.css';

const target = document.getElementById('app') as HTMLElement;
const showVariants = new URLSearchParams(location.search).has('variants');

mount(showVariants ? Variants : App, { target });
