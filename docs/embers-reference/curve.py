# -*- coding: utf-8 -*-

import json
import requests
import sys
from bs4 import BeautifulSoup
import quopri
import hashlib

# Ler o email do stdin - is it a good idea?
encoded_content = sys.stdin.read()

# Encontrar a posição inicial do HTML
start_index = encoded_content.find('<!doctype html>')

decoded_email_iso = quopri.decodestring(encoded_content[start_index:])
decoded_email_utf8 = decoded_email_iso.decode('utf-8')

# Se não encontrar a tag <body>, não é possível continuar
if start_index == -1:
    print(json.dumps({'error': 'No HTML content found in the email.'}))
    sys.exit()
# else:
#    print(decoded_email_utf8[start_index:])
#    sys.exit()

# Extrair o HTML
html_email = decoded_email_utf8
# html_email = decoded_email_utf8[start_index:]

# Parse do HTML
#soup = BeautifulSoup(html_email, 'lxml')
soup = BeautifulSoup(html_email, 'html.parser')

# Encontrar as tags <td> com classe "x_u-bold" para obter a entidade e o valor
entity_tag = soup.find('td', class_='u-bold')
amount_tag = entity_tag.find_next_sibling('td', class_='u-bold')

# Encontrar as tags <td> com classe "x_u-greySmaller" para obter a data
date_tag = soup.find('td', class_='u-greySmaller u-padding__top--half')

name_and_card_tag = soup.find_all('td', class_='u-padding__top--half')[-2]

# Extrair texto das tags encontradas
entity = entity_tag.get_text(strip=True)
amount = amount_tag.get_text(strip=True).replace(u'€', '')
date = date_tag.get_text(strip=True)
name_and_card = ' '.join(name_and_card_tag.stripped_strings)

combined_data = entity + amount + date + name_and_card
combined_data_bytes = combined_data.encode('utf-8')
unique_id = hashlib.sha256(combined_data_bytes).hexdigest()

# Criar um dicionário com as informações
parsed_data = {
    'entity': entity,
    'amount': amount,
    'date': date,
    'card': name_and_card,
    'digest': unique_id,
    'user_id': "5e347bc019af471956a1a4dd" #prod #deve ser definido dinamicamente (arg)
    #'user_id': "5e2272c01d41c80540cb6421" #dev
}

# Definir a URL da sua API ExpensesController
api_url = 'https://embers.brasume.com/admin/expenses/add_expense'

#dev
#api_url = 'http://localhost:3000/admin/expenses/add_expense'

# Fazer uma solicitação POST para a API com os dados JSON
response = requests.post(api_url, json=parsed_data)

# Verificar se a solicitação foi bem-sucedida
if response.ok:
    print("Expense criada com sucesso.")
else:
    try:
        json_data = response.json()
        if 'errors' in json_data:
            print("Erro ao criar Expense:", json_data['errors'])
        else:
            print("Erro ao criar Expense. Code:", response.status_code)
    except ValueError:
        print("Erro ao processar resposta. Response:", response.text)

# Converter o dicionário para formato JSON
# json_output = json.dumps(parsed_data, ensure_ascii=False)

# Exibir o output em JSON
# print(json_output)
