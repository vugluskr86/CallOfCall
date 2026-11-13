import { useEffect, useRef } from "react";
import { startGame, stopGame } from "@/game/boot";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    void startGame(canvas);
    return () => stopGame();
  }, []);

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} aria-label="3D FPS game" />
      <div id="ui-overlay">
        <div id="hud" className="hidden">
          <div className="top-left panel-lite">
            <span className="eyebrow">СЕКТОР 07</span>
            <strong id="wave-label">ВОЛНА 1 / 5</strong>
            <span id="enemy-count">ПРОТИВНИКИ 0</span>
          </div>
          <div className="top-right">
            <div id="room-hud" className="hidden">КОМНАТА <b id="room-hud-code">—</b> · <span id="room-hud-players">1</span>/4</div>
            <div id="score-label">СЧЁТ 000000</div>
          </div>
          <div id="team-list" className="hidden" />
          <div id="crosshair"><i /><i /><i /><i /><b /></div>
          <div id="hitmarker">×</div>
          <div id="message" />
          <div id="pickup-prompt" />
          <div id="reload-bar"><span id="reload-fill" /></div>
          <div className="bottom-left hud-card">
            <div className="card-label">СОСТОЯНИЕ</div>
            <div className="health-row"><span id="health-value">100</span><small>HP</small></div>
            <div className="health-track"><span id="health-fill" /></div>
            <div id="kill-label">УСТРАНЕНО 0</div>
          </div>
          <div className="bottom-center" id="weapon-slots">
            <div className="weapon-slot" data-slot="pistol"><kbd>1</kbd><span>P-12</span></div>
            <div className="weapon-slot locked" data-slot="rifle"><kbd>2</kbd><span>AR-30</span></div>
            <div className="weapon-slot locked" data-slot="lmg"><kbd>3</kbd><span>M-60</span></div>
          </div>
          <div className="bottom-right hud-card ammo-card">
            <div id="weapon-name" className="card-label">ПИСТОЛЕТ P-12</div>
            <div className="ammo-row"><span id="ammo-mag">12</span><span className="ammo-sep">/</span><span id="ammo-reserve">72</span></div>
            <div id="fire-mode">ОДИНОЧНЫЙ · R — ПЕРЕЗАРЯДКА</div>
          </div>
          <div id="controls-hint">WASD — движение · SHIFT — бег · SPACE — прыжок · E — подобрать · ESC — пауза</div>
        </div>
        <button id="mute-button" className="icon-button" type="button" aria-label="Выключить звук">ЗВУК: ВКЛ</button>
        <div id="damage-vignette" />
        <div id="menu-overlay">
          <section id="menu-panel" className="menu-panel">
            <div className="menu-kicker">ARENA PROTOCOL // 05</div>
            <h1 id="menu-title">БЛОЧНЫЙ<br /><em>ШТУРМ</em></h1>
            <p id="menu-description">Пять волн. Три ствола. Ни одного лишнего патрона.</p>
            <div id="menu-stats" className="feature-row">
              <span>БЛОЧНЫЕ ВРАГИ</span><span>ДРОП СНАРЯЖЕНИЯ</span><span>ЖИВОЙ ИИ</span>
            </div>
            <div id="menu-controls" className="controls-grid">
              <div><kbd>WASD</kbd><span>движение</span></div>
              <div><kbd>ЛКМ</kbd><span>огонь</span></div>
              <div><kbd>1—3</kbd><span>оружие</span></div>
              <div><kbd>E</kbd><span>подбор</span></div>
              <div><kbd>R</kbd><span>перезарядка</span></div>
              <div><kbd>SHIFT</kbd><span>ускорение</span></div>
            </div>
            <button id="primary-button" className="primary-button" type="button">НАЧАТЬ ШТУРМ <span>→</span></button>
            <div id="multiplayer-setup">
              <div className="multiplayer-heading"><span>КООПЕРАТИВ · 2—4 ИГРОКА</span><small>общие волны по коду комнаты</small></div>
              <label className="field-label" htmlFor="player-name">ПОЗЫВНОЙ</label>
              <input id="player-name" className="text-field" maxLength={16} defaultValue="Боец" autoComplete="off" />
              <button id="create-room-button" className="multiplayer-button" type="button">СОЗДАТЬ КОМНАТУ</button>
              <div className="join-row">
                <input id="room-code-input" className="text-field" maxLength={5} placeholder="КОД КОМНАТЫ" autoComplete="off" />
                <button id="join-room-button" className="multiplayer-button" type="button">ВОЙТИ</button>
              </div>
            </div>
            <div id="lobby-panel" className="hidden">
              <div className="lobby-code-label">КОД КОМНАТЫ</div>
              <button id="copy-room-code" type="button" title="Скопировать код"><strong id="lobby-code">—</strong><span>НАЖМИ, ЧТОБЫ СКОПИРОВАТЬ</span></button>
              <div id="lobby-players" />
            </div>
            <div id="network-status" role="status" />
            <button id="secondary-button" className="secondary-button hidden" type="button">НАЧАТЬ ЗАНОВО</button>
            <p id="menu-footnote">SPACE — старт · M — звук · рекорд сохраняется в этом браузере</p>
          </section>
          <div className="menu-side" aria-hidden="true"><span>07</span><small>COMBAT<br />SIMULATION</small></div>
        </div>
      </div>
    </div>
  );
}
