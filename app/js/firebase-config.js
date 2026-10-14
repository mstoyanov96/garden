/* =========================================================================
   firebase-config.js — настройки за облачната синхронизация
   -------------------------------------------------------------------------
   КАК ДА ГО ПОПЪЛНИШ (еднократно, ~5 минути):

   1) Влез в https://console.firebase.google.com с твой Google акаунт.
   2) „Add project" → име (напр. „orehova-gradina") → създай (може без Analytics).
   3) Вляво „Build → Firestore Database" → „Create database" →
      избери регион „europe-west" → старт в „production mode".
   4) Вляво „Build → Authentication" → „Get started" →
      таб „Sign-in method" → включи „Anonymous" → Save.
   5) „Build → Firestore Database → Rules" → постави това и натисни „Publish":

        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /{document=**} {
              allow read, write: if request.auth != null;
            }
          }
        }

   6) Горе вляво ⚙ „Project settings" → надолу „Your apps" → икона </> (Web) →
      дай име → „Register app". Ще ти покаже блок „firebaseConfig = {...}".
      Копирай стойностите в полетата по-долу (замести всичко с PASTE_...).

   Това е всичко. Щом попълниш стойностите, синхронизацията се включва сама.
   ========================================================================= */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAKCk_bX5tORJrUq-AjAVNMS0BuDePdhvA',
  authDomain: 'orehi-f8185.firebaseapp.com',
  projectId: 'orehi-f8185',
  storageBucket: 'orehi-f8185.firebasestorage.app',
  messagingSenderId: '175982371885',
  appId: '1:175982371885:web:b0d5d1a5816766c98fc4a4'
};
