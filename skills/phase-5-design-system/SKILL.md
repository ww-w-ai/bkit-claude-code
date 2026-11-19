---
name: phase-5-design-system
context: fork
background: false
classification: capability
classification-reason: Pattern guidance may overlap with model's built-in knowledge as it improves
deprecation-risk: medium
effort: medium
user-invocable: false
description: |
  Build platform-independent design systems and consistent component libraries.
  Triggers: design system, component library, design tokens
  default: bkit:pipeline-guide
  frontend: bkit:frontend-architect
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash
next-skill: phase-6-ui-integration
pdca-phase: do
task-template: "[Phase-5] {feature}"
---

# Phase 5: Design System

> Build platform-independent design system

## Purpose

Build a reusable UI component library. Enable consistent design and fast development.

---

## What is a Design System?

### Definition

A design system is **a collection of reusable components and clear standards** that enables building consistent user experiences at scale.

### Why is it Needed? (Framework Agnostic)

| Problem | Design System Solution |
|---------|----------------------|
| Designer-developer mismatch | Single Source of Truth |
| Duplicate component development | Reusable component library |
| Inconsistent UI/UX | Unified design tokens and rules |
| Increased maintenance cost | Centralized change management |
| Delayed new member onboarding | Documented component catalog |

### 3 Layers of Design System

```
┌─────────────────────────────────────────────────────┐
│              Design Tokens                           │
│   Color, Typography, Spacing, Radius, Shadow, ...   │
├─────────────────────────────────────────────────────┤
│              Core Components                         │
│   Button, Input, Card, Dialog, Avatar, Badge, ...   │
├─────────────────────────────────────────────────────┤
│            Composite Components                      │
│   Form, DataTable, Navigation, SearchBar, ...       │
└─────────────────────────────────────────────────────┘
```

### Platform-specific Implementation Tools

| Platform | Recommended Tools | Design Token Method |
|----------|------------------|---------------------|
| **Web (React/Next.js)** | shadcn/ui, Radix | CSS Variables |
| **Web (Vue)** | Vuetify, PrimeVue | CSS Variables |
| **Flutter** | Material 3, Custom Theme | ThemeData |
| **iOS (SwiftUI)** | Native Components | Asset Catalog, Color Set |
| **Android (Compose)** | Material 3 | MaterialTheme |
| **React Native** | NativeBase, Tamagui | StyleSheet + Theme |

---

## What to Do in This Phase

1. **Install Base Components**: Button, Input, Card, etc.
2. **Customize**: Adjust to project style
3. **Composite Components**: Combine multiple base components
4. **Documentation**: Document component usage

## Deliverables

```
components/
└── ui/                     # shadcn/ui components
    ├── button.tsx
    ├── input.tsx
    ├── card.tsx
    └── ...

lib/
└── utils.ts                # Utilities (cn function, etc.)

docs/02-design/
└── design-system.md        # Design system specification
```

## PDCA Application

- **Plan**: Required component list
- **Design**: Component structure, variants design
- **Do**: Implement/customize components
- **Check**: Review consistency
- **Act**: Finalize and proceed to Phase 6

## Level-wise Application

| Level | Application Method |
|-------|-------------------|
| Starter | Optional (simple projects may skip) |
| Dynamic | Required |
| Enterprise | Required (including design tokens) |

## shadcn/ui Installation

The shadcn CLI is pinned to `4.23.0` in every command below. `init` and `add` write config and component source into your repository, so the version must not float. To upgrade, change all pinned commands together.

```bash
# Initial setup
npx shadcn@4.23.0 init

# Add components
npx shadcn@4.23.0 add button
npx shadcn@4.23.0 add input
npx shadcn@4.23.0 add card
```

## Required Component List

### Basic
- Button, Input, Textarea
- Card, Badge, Avatar
- Dialog, Sheet, Popover

### Form
- Form, Label, Select
- Checkbox, Radio, Switch

### Navigation
- Navigation Menu, Tabs
- Breadcrumb, Pagination

## Custom Theme Building

### Design Token Override

shadcn/ui is CSS variable-based, so customize themes in `globals.css`.

```css
/* globals.css */
@layer base {
  :root {
    /* ===== Colors ===== */
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 221.2 83.2% 53.3%;      /* Brand main color */
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --accent: 210 40% 96.1%;
    --destructive: 0 84.2% 60.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;

    /* ===== Typography ===== */
    --font-sans: 'Pretendard', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;

    /* ===== Spacing (rem units) ===== */
    --spacing-xs: 0.25rem;   /* 4px */
    --spacing-sm: 0.5rem;    /* 8px */
    --spacing-md: 1rem;      /* 16px */
    --spacing-lg: 1.5rem;    /* 24px */
    --spacing-xl: 2rem;      /* 32px */

    /* ===== Border Radius ===== */
    --radius: 0.5rem;
    --radius-sm: 0.25rem;
    --radius-lg: 0.75rem;
    --radius-full: 9999px;

    /* ===== Shadows ===== */
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --primary: 217.2 91.2% 59.8%;
    /* ... dark mode overrides */
  }
}
```

### Tailwind Config Extension

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'hsl(var(--brand-50))',
          500: 'hsl(var(--brand-500))',
          900: 'hsl(var(--brand-900))',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      spacing: {
        'xs': 'var(--spacing-xs)',
        'sm': 'var(--spacing-sm)',
        'md': 'var(--spacing-md)',
        'lg': 'var(--spacing-lg)',
        'xl': 'var(--spacing-xl)',
      },
      borderRadius: {
        'sm': 'var(--radius-sm)',
        'DEFAULT': 'var(--radius)',
        'lg': 'var(--radius-lg)',
        'full': 'var(--radius-full)',
      },
    },
  },
}
```

### Design Token Documentation

Recommended to create `docs/02-design/design-tokens.md` per project:

| Token | Value | Purpose |
|-------|-------|---------|
| `--primary` | `221.2 83.2% 53.3%` | Brand main color |
| `--radius` | `0.5rem` | Default border-radius |
| `--font-sans` | `Pretendard` | Body font |

## Component Customization

```tsx
// Extend default button to project style
const Button = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { isLoading?: boolean }
>(({ isLoading, children, ...props }, ref) => {
  return (
    <ButtonPrimitive ref={ref} {...props}>
      {isLoading ? <Spinner /> : children}
    </ButtonPrimitive>
  );
});
```

---

## Mobile App Design System

### Flutter: Custom Theme Building

Flutter defines design tokens through `ThemeData`.

```dart
// lib/theme/app_theme.dart
import 'package:flutter/material.dart';

class AppTheme {
  // ===== Design Tokens =====

  // Colors
  static const Color primary = Color(0xFF3B82F6);
  static const Color secondary = Color(0xFF64748B);
  static const Color destructive = Color(0xFFEF4444);
  static const Color background = Color(0xFFFFFFFF);
  static const Color foreground = Color(0xFF0F172A);

  // Spacing
  static const double spacingXs = 4.0;
  static const double spacingSm = 8.0;
  static const double spacingMd = 16.0;
  static const double spacingLg = 24.0;
  static const double spacingXl = 32.0;

  // Border Radius
  static const double radiusSm = 4.0;
  static const double radiusMd = 8.0;
  static const double radiusLg = 12.0;
  static const double radiusFull = 9999.0;

  // ===== Theme Data =====

  static ThemeData get lightTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
    ),
    fontFamily: 'Pretendard',

    // Button Theme
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        padding: EdgeInsets.symmetric(
          horizontal: spacingMd,
          vertical: spacingSm,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusMd),
        ),
      ),
    ),

    // Card Theme
    cardTheme: CardTheme(
      elevation: 2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusLg),
      ),
    ),

    // Input Theme
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusMd),
      ),
      contentPadding: EdgeInsets.all(spacingSm),
    ),
  );

  static ThemeData get darkTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.dark,
    ),
    fontFamily: 'Pretendard',
    // ... dark theme overrides
  );
}
```

### Flutter: Reusable Components

```dart
// lib/components/app_button.dart
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

enum AppButtonVariant { primary, secondary, destructive, outline }

class AppButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final AppButtonVariant variant;
  final bool isLoading;

  const AppButton({
    required this.label,
    this.onPressed,
    this.variant = AppButtonVariant.primary,
    this.isLoading = false,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: isLoading ? null : onPressed,
      style: _getStyle(),
      child: isLoading
          ? SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Text(label),
    );
  }

  ButtonStyle _getStyle() {
    switch (variant) {
      case AppButtonVariant.destructive:
        return ElevatedButton.styleFrom(
          backgroundColor: AppTheme.destructive,
        );
      case AppButtonVariant.outline:
        return ElevatedButton.styleFrom(
          backgroundColor: Colors.transparent,
          side: BorderSide(color: AppTheme.primary),
        );
      default:
        return ElevatedButton.styleFrom();
    }
  }
}
```

### Flutter: Project Structure

```
lib/
├── theme/
│   ├── app_theme.dart          # ThemeData + Design Tokens
│   ├── app_colors.dart         # Color constants
│   ├── app_typography.dart     # TextStyle definitions
│   └── app_spacing.dart        # Spacing constants
├── components/
│   ├── app_button.dart
│   ├── app_input.dart
│   ├── app_card.dart
│   └── app_dialog.dart
└── main.dart
```

---

## Cross-Platform Design Token Sharing

### Design Token JSON (Platform Independent)

Centrally manage tokens with Figma Tokens or Style Dictionary.

```json
// tokens/design-tokens.json
{
  "color": {
    "primary": { "value": "#3B82F6" },
    "secondary": { "value": "#64748B" },
    "destructive": { "value": "#EF4444" }
  },
  "spacing": {
    "xs": { "value": "4px" },
    "sm": { "value": "8px" },
    "md": { "value": "16px" },
    "lg": { "value": "24px" }
  },
  "radius": {
    "sm": { "value": "4px" },
    "md": { "value": "8px" },
    "lg": { "value": "12px" }
  },
  "font": {
    "family": { "value": "Pretendard" },
    "size": {
      "sm": { "value": "14px" },
      "md": { "value": "16px" },
      "lg": { "value": "18px" }
    }
  }
}
```

### Platform-specific Conversion

```bash
# Generate tokens for each platform with Style Dictionary
npx style-dictionary build

# Output:
# - build/css/variables.css      (Web)
# - build/dart/app_tokens.dart   (Flutter)
# - build/swift/AppTokens.swift  (iOS)
# - build/kt/AppTokens.kt        (Android)
```

---

## Design System Checklist (Platform Agnostic)

### Required Items

- [ ] **Design Tokens Definition**
  - [ ] Colors (Primary, Secondary, Semantic)
  - [ ] Typography (Font Family, Sizes, Weights)
  - [ ] Spacing (xs, sm, md, lg, xl)
  - [ ] Border Radius
  - [ ] Shadows/Elevation

- [ ] **Core Components**
  - [ ] Button (variants: primary, secondary, outline, destructive)
  - [ ] Input/TextField
  - [ ] Card
  - [ ] Dialog/Modal
  - [ ] Avatar
  - [ ] Badge

- [ ] **Composite Components**
  - [ ] Form (with validation)
  - [ ] Navigation (Header, Sidebar, Bottom Nav)
  - [ ] Data Display (Table, List)

- [ ] **Documentation**
  - [ ] Component catalog (Storybook / Widgetbook)
  - [ ] Usage guidelines
  - [ ] Do's and Don'ts

---

## Template

See `templates/pipeline/phase-5-design-system.template.md`

## Next Phase

Phase 6: UI Implementation + API Integration → Components are ready, now implement actual screens
