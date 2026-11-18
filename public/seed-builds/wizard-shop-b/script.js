let buttons = document.querySelectorAll(".buy")

for (let i = 0; i < buttons.length; i++) {
  buttons[i].addEventListener("click", function() {
    buttons[i].innerHTML = "SOLD OUT"
  })
}
