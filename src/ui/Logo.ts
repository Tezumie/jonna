// The app logo (assets/logo.svg) as an <img>. An <img> rather than inline SVG: the logo uses
// clip-path ids, which would collide when it is shown more than once (tab icon + welcome).
import logoSvg from "../../assets/logo.svg";

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(logoSvg)}`;

export function logo(size: number, className = "logo"): HTMLImageElement {
  const img = document.createElement("img");
  // "app-logo" on every one: the theme turns it dark on a light background (--logo-filter).
  img.className = `app-logo ${className}`;
  img.src = LOGO_URL;
  img.width = size;
  img.height = size;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.draggable = false;
  return img;
}
