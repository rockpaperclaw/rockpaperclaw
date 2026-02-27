const moves = ["rock", "paper", "scissors"];

const scores = {
  wins: 0,
  losses: 0,
  draws: 0,
};

const playerMoveEl = document.getElementById("player-move");
const cpuMoveEl = document.getElementById("cpu-move");
const resultEl = document.getElementById("result");
const winsEl = document.getElementById("wins");
const lossesEl = document.getElementById("losses");
const drawsEl = document.getElementById("draws");

function randomMove() {
  const index = Math.floor(Math.random() * moves.length);
  return moves[index];
}

function winner(player, cpu) {
  if (player === cpu) return "draw";
  if (
    (player === "rock" && cpu === "scissors") ||
    (player === "paper" && cpu === "rock") ||
    (player === "scissors" && cpu === "paper")
  ) {
    return "win";
  }
  return "loss";
}

function updateScore(result) {
  if (result === "win") scores.wins += 1;
  if (result === "loss") scores.losses += 1;
  if (result === "draw") scores.draws += 1;

  winsEl.textContent = String(scores.wins);
  lossesEl.textContent = String(scores.losses);
  drawsEl.textContent = String(scores.draws);
}

function prettify(move) {
  return move.charAt(0).toUpperCase() + move.slice(1);
}

function playRound(playerChoice) {
  const cpuChoice = randomMove();
  const result = winner(playerChoice, cpuChoice);

  playerMoveEl.textContent = prettify(playerChoice);
  cpuMoveEl.textContent = prettify(cpuChoice);

  if (result === "win") resultEl.textContent = "You win this round!";
  if (result === "loss") resultEl.textContent = "OpenClaw wins this round.";
  if (result === "draw") resultEl.textContent = "Draw round.";

  updateScore(result);
}

document.querySelectorAll(".move").forEach((button) => {
  button.addEventListener("click", () => {
    const move = button.getAttribute("data-move");
    if (!move) return;
    playRound(move);
  });
});

document.getElementById("reset").addEventListener("click", () => {
  scores.wins = 0;
  scores.losses = 0;
  scores.draws = 0;

  playerMoveEl.textContent = "—";
  cpuMoveEl.textContent = "—";
  resultEl.textContent = "Pick a move to start the match.";

  winsEl.textContent = "0";
  lossesEl.textContent = "0";
  drawsEl.textContent = "0";
});
