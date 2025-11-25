<!DOCTYPE html>
<html lang="lv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vārdu Zona - Reģistrācija un Pierakstīšanās</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <!-- Reģistrācija -->
    <h2>Reģistrācija</h2>
    <form id="signup-form">
      <input type="text" id="signup-username" placeholder="Lietotājvārds" required>
      <input type="password" id="signup-password" placeholder="Parole" required>
      <button type="submit">Reģistrēties</button>
    </form>

    <!-- Pierakstīšanās -->
    <h2>Pierakstīšanās</h2>
    <form id="signin-form">
      <input type="text" id="signin-username" placeholder="Lietotājvārds" required>
      <input type="password" id="signin-password" placeholder="Parole" required>
      <button type="submit">Pieteikties</button>
    </form>

    <p id="status"></p>
  </div>

  <script src="script.js"></script>
</body>
</html>
