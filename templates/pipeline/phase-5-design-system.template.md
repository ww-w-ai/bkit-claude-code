# Design System Specification

> Phase 5 Deliverable: Component system definition

**Project**: {{project_name}}
**Date**: {{date}}
**Version**: 1.0

---

## 1. Design Tokens

### 1.1 Colors
```css
:root {
  /* Primary */
  --primary: #0066FF;
  --primary-hover: #0052CC;

  /* Neutral */
  --background: #FFFFFF;
  --foreground: #171717;
  --muted: #F5F5F5;

  /* Semantic */
  --success: #22C55E;
  --warning: #F59E0B;
  --error: #EF4444;
}
```

### 1.2 Typography
| Name | Size | Weight | Usage |
|------|------|--------|-------|
| h1 | 36px | 700 | Page title |
| h2 | 24px | 600 | Section title |
| body | 16px | 400 | Body text |
| small | 14px | 400 | Helper text |

### 1.3 Spacing
```
4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px
```

---

## 2. Component List

### 2.1 Basic Components
| Component | Status | Description |
|-----------|--------|-------------|
| Button | ✅ | Button |
| Input | ✅ | Input field |
| Card | ✅ | Card container |
| Badge | ✅ | Badge/Tag |
| Avatar | ✅ | Avatar |

### 2.2 Form Components
| Component | Status | Description |
|-----------|--------|-------------|
| Form | ✅ | Form wrapper |
| Label | ✅ | Label |
| Select | ✅ | Select dropdown |
| Checkbox | ✅ | Checkbox |

### 2.3 Feedback Components
| Component | Status | Description |
|-----------|--------|-------------|
| Dialog | ✅ | Dialog/Modal |
| Toast | ✅ | Toast notification |
| Alert | ✅ | Alert banner |

---

## 3. Component Details

### 3.1 Button

**Variants**:
- `default`: Default style
- `outline`: Border only
- `ghost`: No background
- `destructive`: Delete/Danger action

**Sizes**:
- `sm`: Small button
- `default`: Default size
- `lg`: Large button

**Usage Example**:
```tsx
<Button variant="default" size="default">
  Button
</Button>

<Button variant="outline" size="sm">
  Small Button
</Button>
```

---

## 4. Installed Components

```bash
# shadcn/ui component installation log
npx shadcn@4.23.0 add button
npx shadcn@4.23.0 add input
npx shadcn@4.23.0 add card
# ...
```

---

## 5. Validation Checklist

- [ ] All required basic components exist
- [ ] Design tokens applied consistently
- [ ] Accessibility (a11y) considered
- [ ] Responsive design supported

---

## 6. Next Steps

Proceed to Phase 6: UI Implementation + API Integration
