# JSOS Design System
## Frutiger Aero × Art Deco Fusion

**Version:** 1.0.0  
**Last Updated:** February 2026

---

## Overview

The JSOS design system merges two iconic aesthetic movements:

- **Frutiger Aero** (2004-2013): The glossy, optimistic, nature-inspired design language of Windows Vista/7 era
- **American Art Deco** (1920s-1940s): Geometric luxury, streamlined elegance, and industrial sophistication

This fusion creates a unique visual identity that feels simultaneously futuristic and timeless, built entirely with modern web technologies.

### Design Philosophy

> "What if Windows Vista was designed during the Art Deco period?"

- Optimistic transparency meets geometric precision
- Organic flowing elements balanced with industrial structure
- Digital glass aesthetics framed in metallic luxury
- Depth through layering, light, and reflection

---

## Design Tokens

### Color System

#### Primary Palette: Frutiger Aero

```css
:root {
  /* Aero Blues */
  --color-aero-primary: #0078D7;
  --color-aero-sky: #6AB8F2;
  --color-aero-deep: #003E5C;
  
  /* Aero Accents */
  --color-aero-green: #7FBA00;
  --color-aero-orange: #FFB900;
  --color-aero-pearl: #F0F0F0;
}
```

#### Accent Palette: Art Deco

```css
:root {
  /* Metallic Tones */
  --color-deco-gold: #D4AF37;
  --color-deco-gold-light: #FFD700;
  --color-deco-gold-dark: #B8860B;
  --color-deco-silver: #C0C0C0;
  --color-deco-bronze: #CD7F32;
  
  /* Luxury Accents */
  --color-deco-navy: #001F3F;
  --color-deco-crimson: #8B0000;
  --color-deco-jade: #00A86B;
}
```

#### Semantic Colors

```css
:root {
  /* UI States */
  --color-success: #7FBA00;
  --color-warning: #FFB900;
  --color-error: #E81123;
  --color-info: #0078D7;
  
  /* Neutral Scale */
  --color-neutral-0: #FFFFFF;
  --color-neutral-100: #F0F0F0;
  --color-neutral-200: #E0E0E0;
  --color-neutral-300: #C0C0C0;
  --color-neutral-400: #A0A0A0;
  --color-neutral-500: #808080;
  --color-neutral-600: #606060;
  --color-neutral-700: #404040;
  --color-neutral-800: #202020;
  --color-neutral-900: #000000;
}
```

#### Gradient Presets

```css
:root {
  /* Aero Glass Gradient */
  --gradient-aero-glass: linear-gradient(180deg,
    rgba(255, 255, 255, 0.4) 0%,
    rgba(255, 255, 255, 0.1) 50%,
    rgba(255, 255, 255, 0.05) 100%);
  
  /* Deco Gold Shimmer */
  --gradient-deco-gold: linear-gradient(135deg,
    #D4AF37 0%,
    #FFD700 25%,
    #D4AF37 50%,
    #B8860B 75%,
    #D4AF37 100%);
  
  /* Fusion Window */
  --gradient-fusion: linear-gradient(180deg,
    rgba(212, 175, 55, 0.3) 0%,
    rgba(0, 120, 215, 0.2) 100%);
  
  /* Desktop Background */
  --gradient-desktop: radial-gradient(circle at 30% 40%,
    rgba(0, 120, 215, 0.6) 0%,
    rgba(0, 80, 180, 0.8) 50%,
    rgba(0, 40, 100, 1) 100%);
}
```

### Typography

#### Font Families

```css
:root {
  /* Primary: Aero Heritage */
  --font-primary: 'Segoe UI', 'Inter', system-ui, -apple-system, sans-serif;
  
  /* Display: Deco Geometric */
  --font-display: 'Futura', 'Poppins', 'Montserrat', sans-serif;
  
  /* Monospace: Technical */
  --font-mono: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}
```

#### Type Scale

```css
:root {
  --text-xs: 0.75rem;     /* 12px - Captions, labels */
  --text-sm: 0.875rem;    /* 14px - Small body, metadata */
  --text-base: 1rem;      /* 16px - Body text */
  --text-lg: 1.125rem;    /* 18px - Emphasized text */
  --text-xl: 1.5rem;      /* 24px - H3, section titles */
  --text-2xl: 2rem;       /* 32px - H2, page titles */
  --text-3xl: 3rem;       /* 48px - H1, hero text */
  --text-4xl: 4rem;       /* 64px - Display text */
  
  /* Font Weights */
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  
  /* Line Heights */
  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;
  
  /* Letter Spacing */
  --letter-spacing-tight: -0.025em;
  --letter-spacing-normal: 0;
  --letter-spacing-wide: 0.05em;
  --letter-spacing-wider: 0.1em;
}
```

#### Typography Classes

```css
/* Glass Text Effect */
.text-aero-glass {
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 
    0 1px 2px rgba(0, 0, 0, 0.3),
    0 0 20px rgba(255, 255, 255, 0.4);
}

/* Deco Gold Text */
.text-deco-gold {
  background: linear-gradient(180deg, #FFD700, #D4AF37);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

/* Deco Display Heading */
.heading-deco {
  font-family: var(--font-display);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
  text-transform: uppercase;
}
```

### Spacing Scale

```css
:root {
  --space-0: 0;
  --space-1: 0.25rem;   /* 4px */
  --space-2: 0.5rem;    /* 8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.5rem;    /* 24px */
  --space-6: 2rem;      /* 32px */
  --space-8: 3rem;      /* 48px */
  --space-10: 4rem;     /* 64px */
  --space-12: 6rem;     /* 96px */
  --space-16: 8rem;     /* 128px */
}
```

### Elevation & Shadows

```css
:root {
  /* Aero Glass Shadows */
  --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.15);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.2);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.3);
  --shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.4);
  
  /* Aero Glow Effects */
  --glow-blue: 0 0 20px rgba(0, 120, 215, 0.5);
  --glow-gold: 0 0 20px rgba(212, 175, 55, 0.5);
  --glow-white: 0 0 20px rgba(255, 255, 255, 0.5);
  
  /* Inset Highlights */
  --highlight-top: inset 0 1px 0 rgba(255, 255, 255, 0.4);
  --highlight-bottom: inset 0 -1px 0 rgba(0, 0, 0, 0.2);
}
```

### Border Radius

```css
:root {
  --radius-none: 0;
  --radius-sm: 0.25rem;   /* 4px - Subtle rounding */
  --radius-md: 0.5rem;    /* 8px - Standard UI elements */
  --radius-lg: 1rem;      /* 16px - Cards, panels */
  --radius-xl: 1.5rem;    /* 24px - Large containers */
  --radius-full: 9999px;  /* Circular elements */
}
```

### Animation Timing

```css
:root {
  /* Duration */
  --duration-instant: 0.1s;
  --duration-fast: 0.2s;
  --duration-normal: 0.3s;
  --duration-slow: 0.5s;
  --duration-slower: 0.8s;
  
  /* Easing: Aero (Smooth, Organic) */
  --ease-aero: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-aero-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-aero-out: cubic-bezier(0, 0, 0.2, 1);
  
  /* Easing: Deco (Precise, Mechanical) */
  --ease-deco: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-deco-in: cubic-bezier(0.65, 0, 1, 1);
  --ease-deco-out: cubic-bezier(0, 0, 0.35, 1);
  
  /* Bounce */
  --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
}
```

---

## Visual Effects

### Aero Glass Effect

The signature glass effect that defines the Aero aesthetic.

```css
.aero-glass {
  background: var(--gradient-aero-glass);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.3);
  box-shadow: 
    var(--shadow-lg),
    var(--highlight-top),
    var(--highlight-bottom);
}

/* Glass variants */
.aero-glass-light {
  background: linear-gradient(180deg,
    rgba(255, 255, 255, 0.6) 0%,
    rgba(255, 255, 255, 0.3) 100%);
  backdrop-filter: blur(15px) saturate(160%);
}

.aero-glass-dark {
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0.4) 0%,
    rgba(0, 0, 0, 0.6) 100%);
  backdrop-filter: blur(20px) saturate(150%);
  border-color: rgba(255, 255, 255, 0.1);
}
```

### Art Deco Chrome Frame

Geometric metallic borders with corner ornaments.

```css
.deco-frame {
  position: relative;
  border: 3px solid;
  border-image: linear-gradient(135deg,
    #C0C0C0 0%,
    #F0F0F0 25%,
    #C0C0C0 50%,
    #A0A0A0 75%,
    #C0C0C0 100%) 1;
}

/* Corner Ornaments */
.deco-frame::before,
.deco-frame::after {
  content: '◆';
  position: absolute;
  color: var(--color-deco-gold);
  font-size: 16px;
  line-height: 1;
}

.deco-frame::before {
  top: -8px;
  left: -8px;
}

.deco-frame::after {
  bottom: -8px;
  right: -8px;
}
```

### Fusion Panel

Combines Aero glass with Deco geometric accents.

```css
.fusion-panel {
  position: relative;
  background: 
    linear-gradient(135deg, 
      rgba(212, 175, 55, 0.15) 0%,
      transparent 100%),
    linear-gradient(180deg,
      rgba(255, 255, 255, 0.3) 0%,
      rgba(255, 255, 255, 0.05) 100%);
  backdrop-filter: blur(15px) saturate(150%);
  border: 2px solid rgba(212, 175, 55, 0.4);
  border-radius: var(--radius-md);
  box-shadow:
    var(--shadow-lg),
    var(--highlight-top),
    inset 0 0 20px rgba(212, 175, 55, 0.1);
}

/* Geometric pattern overlay */
.fusion-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: repeating-linear-gradient(90deg,
    transparent 0,
    transparent 10px,
    rgba(212, 175, 55, 0.3) 10px,
    rgba(212, 175, 55, 0.3) 11px,
    transparent 11px,
    transparent 20px);
}
```

### Glass Effect Fallback

For browsers that don't support `backdrop-filter`.

```css
@supports not (backdrop-filter: blur(20px)) {
  .aero-glass,
  .fusion-panel {
    background: rgba(255, 255, 255, 0.95);
  }
  
  .aero-glass-dark {
    background: rgba(0, 0, 0, 0.85);
  }
}
```

---

## Components

### Buttons

#### Aero Glass Button

```css
.btn-aero {
  /* Structure */
  padding: var(--space-2) var(--space-4);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: var(--radius-sm);
  font-family: var(--font-primary);
  font-size: var(--text-base);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  
  /* Aero Glass Effect */
  background: linear-gradient(180deg,
    rgba(0, 120, 215, 0.8) 0%,
    rgba(0, 90, 180, 0.9) 100%);
  backdrop-filter: blur(10px);
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  box-shadow:
    0 4px 12px rgba(0, 120, 215, 0.4),
    var(--highlight-top);
  
  /* Transition */
  transition: all var(--duration-fast) var(--ease-aero);
}

.btn-aero:hover {
  background: linear-gradient(180deg,
    rgba(0, 140, 235, 0.9) 0%,
    rgba(0, 110, 200, 1) 100%);
  box-shadow:
    0 6px 16px rgba(0, 120, 215, 0.6),
    var(--glow-blue),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
  transform: translateY(-1px);
}

.btn-aero:active {
  transform: translateY(0);
  box-shadow:
    0 2px 8px rgba(0, 120, 215, 0.4),
    inset 0 2px 4px rgba(0, 0, 0, 0.2);
}
```

#### Art Deco Gold Button

```css
.btn-deco {
  /* Structure */
  padding: var(--space-3) var(--space-6);
  border: 2px solid var(--color-deco-gold-light);
  font-family: var(--font-display);
  font-size: var(--text-base);
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-wider);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  
  /* Deco Gold Effect */
  background: linear-gradient(180deg,
    var(--color-deco-gold) 0%,
    var(--color-deco-gold-dark) 100%);
  color: #000;
  box-shadow: 0 4px 12px rgba(212, 175, 55, 0.4);
  
  /* Transition */
  transition: all var(--duration-fast) var(--ease-deco);
}

/* Shimmer Effect */
.btn-deco::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg,
    transparent,
    rgba(255, 255, 255, 0.5),
    transparent);
  transition: left var(--duration-slow) var(--ease-deco);
}

.btn-deco:hover::before {
  left: 100%;
}

.btn-deco:hover {
  border-color: var(--color-deco-gold);
  box-shadow:
    0 6px 16px rgba(212, 175, 55, 0.6),
    var(--glow-gold);
  transform: scale(1.02);
}
```

#### Fusion Button

```css
.btn-fusion {
  padding: var(--space-2) var(--space-5);
  border: 2px solid rgba(212, 175, 55, 0.5);
  border-radius: var(--radius-sm);
  font-family: var(--font-primary);
  font-size: var(--text-base);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--letter-spacing-wide);
  cursor: pointer;
  
  /* Combined Effect */
  background: 
    linear-gradient(135deg,
      rgba(212, 175, 55, 0.3) 0%,
      transparent 100%),
    linear-gradient(180deg,
      rgba(0, 120, 215, 0.7) 0%,
      rgba(0, 90, 180, 0.8) 100%);
  backdrop-filter: blur(10px);
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  box-shadow:
    0 4px 12px rgba(0, 120, 215, 0.4),
    inset 0 1px 0 rgba(212, 175, 55, 0.3);
  
  transition: all var(--duration-fast) var(--ease-aero);
}

.btn-fusion:hover {
  box-shadow:
    0 6px 16px rgba(0, 120, 215, 0.6),
    var(--glow-blue),
    var(--glow-gold);
  transform: translateY(-1px);
}
```

### Windows

#### OS Window Container

```css
.os-window {
  /* Structure */
  display: flex;
  flex-direction: column;
  min-width: 400px;
  min-height: 300px;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  overflow: hidden;
  
  /* Glass Effect */
  background: linear-gradient(180deg,
    rgba(255, 255, 255, 0.3) 0%,
    rgba(255, 255, 255, 0.1) 100%);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.3);
  box-shadow: var(--shadow-xl);
}

/* Window Titlebar */
.os-window-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-4);
  position: relative;
  
  /* Deco-influenced gradient */
  background: linear-gradient(180deg,
    rgba(212, 175, 55, 0.4) 0%,
    rgba(212, 175, 55, 0.2) 100%);
  border-bottom: 2px solid rgba(212, 175, 55, 0.6);
}

/* Titlebar geometric pattern */
.os-window-titlebar::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: repeating-linear-gradient(90deg,
    transparent 0,
    transparent 10px,
    rgba(255, 255, 255, 0.3) 10px,
    rgba(255, 255, 255, 0.3) 11px);
}

/* Window title text */
.os-window-title {
  font-family: var(--font-primary);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-semibold);
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* Window control buttons */
.os-window-controls {
  display: flex;
  gap: var(--space-2);
}

.os-window-control-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: linear-gradient(180deg,
    rgba(255, 255, 255, 0.3) 0%,
    rgba(255, 255, 255, 0.1) 100%);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-aero);
}

.os-window-control-btn:hover {
  background: linear-gradient(180deg,
    rgba(255, 255, 255, 0.5) 0%,
    rgba(255, 255, 255, 0.2) 100%);
  box-shadow: var(--glow-white);
}

/* Window content area */
.os-window-content {
  flex: 1;
  padding: var(--space-4);
  overflow: auto;
}
```

#### Window Open Animation

```css
@keyframes window-open-fusion {
  0% {
    opacity: 0;
    transform: scale(0.8) translateY(20px);
    backdrop-filter: blur(0px);
  }
  50% {
    backdrop-filter: blur(10px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
    backdrop-filter: blur(20px);
  }
}

.os-window.opening {
  animation: window-open-fusion var(--duration-normal) var(--ease-aero);
}
```

### Taskbar

```css
.taskbar {
  /* Structure */
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-4);
  gap: var(--space-2);
  z-index: 9999;
  
  /* Dark glass effect */
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0.8) 0%,
    rgba(0, 0, 0, 0.9) 100%);
  backdrop-filter: blur(30px) saturate(150%);
  border-top: 1px solid rgba(212, 175, 55, 0.5);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
}

/* Deco geometric pattern */
.taskbar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: repeating-linear-gradient(90deg,
    var(--color-deco-gold) 0,
    var(--color-deco-gold) 20px,
    transparent 20px,
    transparent 25px,
    var(--color-deco-gold) 25px,
    var(--color-deco-gold) 30px,
    transparent 30px,
    transparent 50px);
}
```

### Start Button

```css
.start-button {
  /* Structure */
  width: 48px;
  height: 48px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: var(--radius-full);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  
  /* Fusion gradient */
  background: radial-gradient(circle at 30% 30%,
    rgba(212, 175, 55, 0.9) 0%,
    rgba(0, 120, 215, 0.8) 100%);
  box-shadow:
    0 4px 16px rgba(0, 120, 215, 0.6),
    inset 0 2px 4px rgba(255, 255, 255, 0.4),
    inset 0 -2px 4px rgba(0, 0, 0, 0.3);
  
  transition: all var(--duration-fast) var(--ease-aero);
}

/* Glossy orb highlight */
.start-button::before {
  content: '';
  position: absolute;
  top: 10%;
  left: 10%;
  width: 60%;
  height: 40%;
  background: radial-gradient(circle at 30% 30%,
    rgba(255, 255, 255, 0.6) 0%,
    transparent 70%);
  border-radius: var(--radius-full);
  pointer-events: none;
}

.start-button:hover {
  box-shadow:
    0 6px 20px rgba(0, 120, 215, 0.8),
    0 0 40px rgba(212, 175, 55, 0.6),
    inset 0 2px 4px rgba(255, 255, 255, 0.5);
  transform: scale(1.05);
}

.start-button:active {
  transform: scale(0.98);
}
```

### Icons

#### Icon Container

```css
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

/* Aero glossy icon effect */
.icon-aero {
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.icon-aero::after {
  content: '';
  position: absolute;
  top: 10%;
  left: 10%;
  width: 50%;
  height: 30%;
  background: radial-gradient(ellipse at 30% 30%,
    rgba(255, 255, 255, 0.6) 0%,
    transparent 60%);
  border-radius: 50%;
  pointer-events: none;
}

/* Deco metallic icon effect */
.icon-deco {
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5));
  color: var(--color-deco-gold);
}
```

---

## Patterns & Effects

### Glow & Shine Animations

```css
/* Aero Glow Pulse */
@keyframes aero-glow-pulse {
  0%, 100% {
    box-shadow: 0 0 20px rgba(0, 120, 215, 0.4);
  }
  50% {
    box-shadow: 0 0 40px rgba(0, 120, 215, 0.8);
  }
}

.glow-aero {
  animation: aero-glow-pulse 2s ease-in-out infinite;
}

/* Deco Shimmer Sweep */
@keyframes deco-shimmer {
  0% {
    background-position: -200% center;
  }
  100% {
    background-position: 200% center;
  }
}

.shimmer-deco {
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.5) 50%,
    transparent 100%);
  background-size: 200% 100%;
  animation: deco-shimmer 3s ease-in-out infinite;
}
```

### Geometric Patterns

```css
/* Art Deco Sunburst */
.pattern-sunburst {
  background: repeating-conic-gradient(
    from 0deg at 50% 50%,
    transparent 0deg,
    rgba(212, 175, 55, 0.1) 1deg,
    transparent 2deg,
    transparent 10deg
  );
}

/* Art Deco Zigzag */
.pattern-zigzag {
  background: repeating-linear-gradient(135deg,
    transparent,
    transparent 10px,
    rgba(212, 175, 55, 0.2) 10px,
    rgba(212, 175, 55, 0.2) 20px,
    transparent 20px,
    transparent 30px,
    rgba(212, 175, 55, 0.2) 30px,
    rgba(212, 175, 55, 0.2) 40px);
}

/* Deco Diamond Grid */
.pattern-diamond {
  background:
    repeating-linear-gradient(45deg,
      transparent,
      transparent 20px,
      rgba(212, 175, 55, 0.1) 20px,
      rgba(212, 175, 55, 0.1) 21px),
    repeating-linear-gradient(-45deg,
      transparent,
      transparent 20px,
      rgba(212, 175, 55, 0.1) 20px,
      rgba(212, 175, 55, 0.1) 21px);
}
```

### Desktop Backgrounds

```css
.desktop-background {
  width: 100vw;
  height: 100vh;
  position: fixed;
  top: 0;
  left: 0;
  z-index: -1;
  
  /* Fusion background */
  background:
    /* Deco geometric overlay */
    repeating-linear-gradient(45deg,
      transparent,
      transparent 100px,
      rgba(212, 175, 55, 0.05) 100px,
      rgba(212, 175, 55, 0.05) 101px),
    repeating-linear-gradient(-45deg,
      transparent,
      transparent 100px,
      rgba(212, 175, 55, 0.05) 100px,
      rgba(212, 175, 55, 0.05) 101px),
    /* Aero gradient base */
    radial-gradient(circle at 30% 40%,
      rgba(0, 120, 215, 0.6) 0%,
      rgba(0, 80, 180, 0.8) 50%,
      rgba(0, 40, 100, 1) 100%);
}
```

---

## Accessibility

### High Contrast Mode

```css
@media (prefers-contrast: high) {
  .aero-glass,
  .fusion-panel {
    background: rgba(255, 255, 255, 0.98);
    border: 2px solid #000;
  }
  
  .aero-glass-dark {
    background: rgba(0, 0, 0, 0.98);
    border: 2px solid #FFF;
  }
  
  .btn-aero,
  .btn-deco,
  .btn-fusion {
    border-width: 3px;
  }
}
```

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Focus Indicators

```css
:focus-visible {
  outline: 3px solid var(--color-aero-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.btn-aero:focus-visible,
.btn-deco:focus-visible,
.btn-fusion:focus-visible {
  outline-color: var(--color-deco-gold);
  box-shadow:
    var(--glow-blue),
    var(--glow-gold);
}
```

---

## Implementation Guidelines

### CSS Architecture

Organize styles following this structure:

```
src/design-system/
├── tokens/
│   ├── colors.css          # Color variables
│   ├── typography.css      # Font and text variables
│   ├── spacing.css         # Spacing scale
│   ├── effects.css         # Shadows, glows, etc.
│   └── animations.css      # Timing and easing
├── patterns/
│   ├── aero-glass.css      # Aero glass effects
│   ├── deco-geometry.css   # Art Deco patterns
│   └── fusion.css          # Combined effects
├── components/
│   ├── button.css
│   ├── window.css
│   ├── taskbar.css
│   ├── icon.css
│   └── ...
└── utilities/
    ├── layout.css
    ├── typography.css
    └── spacing.css
```

### Component Development

1. **Start with tokens**: Use CSS custom properties for all values
2. **Build with patterns**: Compose glass, geometry, and fusion effects
3. **Add interactions**: Implement hover, focus, and active states
4. **Test accessibility**: Verify contrast, focus, and reduced motion
5. **Optimize performance**: Use `will-change` sparingly, prefer transforms

### Performance Considerations

```css
/* Optimize animations */
.animated-element {
  will-change: transform, opacity;
  transform: translateZ(0); /* Hardware acceleration */
}

/* Optimize backdrop-filter */
.aero-glass {
  /* Limit blur radius for better performance */
  backdrop-filter: blur(20px); /* Acceptable */
  /* backdrop-filter: blur(50px); -- Too expensive */
}
```

### Browser Support

- **Modern browsers**: Full support (Chrome 76+, Firefox 103+, Safari 9+)
- **Fallbacks**: Solid colors for unsupported `backdrop-filter`
- **Progressive enhancement**: Core functionality works everywhere

---

## Usage Examples

### Creating a Window

```html
<div class="os-window opening">
  <div class="os-window-titlebar">
    <span class="os-window-title">My Application</span>
    <div class="os-window-controls">
      <button class="os-window-control-btn" aria-label="Minimize"></button>
      <button class="os-window-control-btn" aria-label="Maximize"></button>
      <button class="os-window-control-btn" aria-label="Close"></button>
    </div>
  </div>
  <div class="os-window-content">
    <!-- Your content here -->
  </div>
</div>
```

### Creating Buttons

```html
<!-- Aero style -->
<button class="btn-aero">Save Changes</button>

<!-- Deco style -->
<button class="btn-deco">Launch Application</button>

<!-- Fusion style -->
<button class="btn-fusion">Open Settings</button>
```

### Using Typography

```html
<h1 class="heading-deco text-deco-gold">JSOS Operating System</h1>
<p class="text-aero-glass">Welcome to the future of computing.</p>
```

---

## Design System Version

**Current Version:** 1.0.0

### Changelog

#### v1.0.0 (February 2026)
- Initial design system release
- Core tokens and components defined
- Aero glass and Art Deco patterns established
- Accessibility guidelines included

---

## Resources & References

### Frutiger Aero Inspiration
- Windows Vista/7 UI elements
- Xbox 360 dashboard (2005-2013)
- iOS 6 skeuomorphic design
- Nature-tech hybrid imagery (bubbles, orbs, water)

### Art Deco Inspiration
- Chrysler Building (New York)
- Radio City Music Hall
- 1920s-30s American posters
- Streamline Moderne architecture

### Technical Documentation
- [CSS Custom Properties (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [backdrop-filter (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

---

*This design system is a living document and will evolve as JSOS develops.*
