export default class DiffuiComponent extends HTMLElement {
  constructor() {
    super();
    let css;
    let html;
    if (this.css) css = this.css();
    if (this.html) html = this.html();
    if (html || css) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `${css ? `<style>${css}</style>` : ""}${html ? html : "<slot></slot>"}`;
    }

    this.shadowRoot?.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const prefix = attr.name.charAt(0);
        if (prefix === "@") {
          if (typeof this[attr.value] === "function") {
            this[attr.value] = this[attr.value].bind(this);
            el.addEventListener(attr.name.slice(1), this[attr.value]);
          }
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  select(selector) {
    return this.shadowRoot.querySelector(selector);
  }

  selectAll(selector) {
    return this.shadowRoot.querySelectorAll(selector);
  }
}
