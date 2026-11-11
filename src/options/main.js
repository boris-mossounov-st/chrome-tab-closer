import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

const isPopup = new URLSearchParams(location.search).has('popup');
document.documentElement.classList.toggle('popup', isPopup);

createApp(App, { isPopup }).mount('#app');
