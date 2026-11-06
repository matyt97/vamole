# Resolver tareas con Gemini

Sube la foto de un problema o tarea y la app te da una explicación paso a paso usando la API de Gemini. También puede dictar la solución en voz alta, despacio, para tomar apuntes.

## Cómo se usa la API key

La app tiene un campo para pegar tu API key de Gemini (gratis en https://aistudio.google.com/apikey). La clave se guarda solo en el navegador de quien la pega (localStorage); **no está en el código ni en este repositorio**.

## Publicarla en línea (Vercel)

1. Entra a https://vercel.com e inicia sesión con GitHub.
2. **Add New → Project**, elige este repositorio y pulsa **Deploy**. No hace falta configurar nada ni agregar variables de entorno.
3. Vercel te da un enlace público que puedes abrir desde el PC o el celular.

## Correrla en local (opcional)

```bash
npm install
npm run dev
```

Opcional: crea `.env.local` con `VITE_GEMINI_API_KEY=tu_clave` para no pegarla cada vez. Ese archivo está en `.gitignore`.

## Notas

- El modelo se cambia en la constante `MODEL` de `src/App.jsx`.
- El dictado usa `speechSynthesis` del navegador; funciona mejor en Chrome o Edge.
