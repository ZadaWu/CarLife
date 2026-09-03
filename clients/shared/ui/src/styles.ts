// 样式入口：使用方 import "@carlife/ui/styles" 即可获得字体、token 与 HUD 样式。
//
// 字体排在最前：@font-face 与 :root 的 --font-ui 要先于其它样式落地，
// 否则首帧会用系统默认字重量出一次布局再跳一次（M14-14）。
import "./fonts.css";
import "./themes/tokens.css";
import "./hud/hud.css";
import "./dialog/dialog.css";
import "./map/map.css";
import "./guide/guide.css";
import "./location/location.css";
import "./departure/departure-card.css";
