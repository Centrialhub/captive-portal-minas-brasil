import { Link } from "react-router-dom";
import logoMinasBrasil from "../assets/logo-minas-brasil.png";

export default function PrivacyPolicy() {
  return (
    <div className="policy-wrapper">
      <div className="policy-card">
        <div className="policy-header">
          <Link to="/" className="policy-back">← Voltar</Link>
          <img
            src={logoMinasBrasil}
            alt="Drogaria Minas Brasil"
            className="policy-logo"
          />
          <h1 className="policy-title">Política de Privacidade</h1>
          <p className="policy-slogan">Captive Portal Wi-Fi — Minas Brasil</p>
        </div>

        <div className="policy-body">
          <p className="policy-intro">
            Esta Política explica como a Minas Brasil trata dados pessoais quando você usa o Wi-Fi disponibilizado por meio deste Captive Portal, seja pelo cadastro com e-mail e senha, seja pela autenticação com Google.
          </p>

          <section className="policy-section">
            <h2>1. Dados Pessoais Coletados</h2>
            <p>Conforme a forma de acesso escolhida, podemos tratar:</p>
            <ul>
              <li>
                <strong>Dados cadastrais:</strong> nome, e-mail, telefone e CPF informado pelo usuário.
              </li>
              <li>
                <strong>Login com Google:</strong> identificador da conta, nome, e-mail verificado, foto de perfil e idioma disponibilizados pelos escopos básicos do OpenID Connect.
              </li>
              <li>
                <strong>Dados técnicos e de acesso:</strong> endereços MAC do dispositivo e do ponto de acesso, endereço IP, SSID, unidade, data e hora, navegador e resultado da autorização da rede.
              </li>
              <li>
                <strong>Consentimento:</strong> versão dos termos aceitos e data e hora do aceite.
              </li>
            </ul>
            <p className="policy-note">
              <strong>Importante:</strong> não solicitamos acesso a contatos, mensagens ou arquivos do Google Drive. Senhas são processadas pelo serviço de autenticação e não são armazenadas em texto legível pela aplicação.
            </p>
          </section>

          <section className="policy-section">
            <h2>2. Finalidade do Tratamento dos Dados</h2>
            <p>Os dados coletados são tratados para as seguintes finalidades legítimas:</p>
            <ol>
              <li>
                <strong>Autenticação e Liberação de Acesso:</strong> Identificar o usuário e liberar a navegação na rede Wi-Fi.
              </li>
              <li>
                <strong>Segurança e prevenção de abusos:</strong> proteger usuários e infraestrutura, investigar falhas e impedir uso indevido.
              </li>
              <li>
                <strong>Operação e suporte:</strong> identificar a unidade, diagnosticar a conexão e manter registros necessários à operação e ao cumprimento de obrigações aplicáveis.
              </li>
              <li>
                <strong>Relacionamento:</strong> registrar o cadastro no Clube Mais/CRM, quando essa integração estiver habilitada e for aplicável ao fluxo escolhido.
              </li>
            </ol>
          </section>

          <section className="policy-section">
            <h2>3. Compartilhamento de Dados</h2>
            <p>
              A Minas Brasil não vende nem aluga seus dados pessoais. O tratamento pode envolver:
            </p>
            <ul>
              <li>
                provedores de autenticação, banco de dados, hospedagem e infraestrutura necessários ao funcionamento do portal;
              </li>
              <li>
                Google, quando você escolhe essa forma de login;
              </li>
              <li>
                Clube Mais/CRM, quando a integração de relacionamento estiver habilitada;
              </li>
              <li>
                autoridades públicas, quando houver obrigação legal ou ordem válida.
              </li>
            </ul>
          </section>

          <section className="policy-section">
            <h2>4. Armazenamento e Segurança</h2>
            <p>
              Usamos controles técnicos e administrativos para restringir o acesso e proteger os dados. Os registros são mantidos pelo período necessário às finalidades informadas e às obrigações aplicáveis, e depois eliminados ou anonimizados quando cabível. O portal usa armazenamento local do navegador para preservar o contexto da autenticação e da conexão.
            </p>
          </section>

          <section className="policy-section">
            <h2>5. Direitos do Titular (LGPD)</h2>
            <p>Nos termos da LGPD, você pode solicitar, conforme aplicável:</p>
            <ul>
              <li>confirmação do tratamento e acesso aos dados;</li>
              <li>correção de dados incompletos, inexatos ou desatualizados;</li>
              <li>informação sobre compartilhamentos;</li>
              <li>anonimização, bloqueio, portabilidade ou eliminação, nas hipóteses legais;</li>
              <li>revogação do consentimento e informação sobre suas consequências.</li>
            </ul>
            <p>
              A permissão concedida ao Google também pode ser revogada nas configurações de segurança da sua Conta Google. A revogação não elimina automaticamente registros cuja conservação seja necessária por outra base legal.
            </p>
          </section>

          <section className="policy-section">
            <h2>6. Contato</h2>
            <p>
              O controlador é a <strong>Guedes e Paixão Ltda. (Drogaria Minas-Brasil)</strong>. Para dúvidas ou para exercer seus direitos, use o telefone <strong>(38) 2211-2080</strong> ou o <a href="https://www.drogariaminasbrasil.com.br/fale-conosco/" target="_blank" rel="noreferrer">canal oficial de atendimento</a>.
            </p>
          </section>
        </div>

        <div className="policy-footer">
          <Link to="/" className="portal-btn">Voltar ao portal</Link>
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    </div>
  );
}
